/**
 * config-trust.mjs — §14 S3 invariant:
 *   "Command-producing config fields (deploy.*) are treated as untrusted input:
 *    shape-pinned, allowlist-validated, and NEVER sourced from a platform/remote config.
 *    Config values are only ever used as data / child-process argv — never eval'd or
 *    passed to Function()."
 *
 * Zero runtime dependencies. Plain Node ESM.
 */

// Dot-paths into the config object that produce shell commands.
// These fields require extra scrutiny and must NEVER come from a platform source.
export const COMMAND_FIELD_PATHS = ["deploy.staging", "deploy.prod"];

/**
 * Allowlist regex for command strings.
 * Permits: alphanumeric, space, _ . / : = @ + " ' -
 * Rejects: ; | & $ ` ( ) { } < > \ newline tab \0 * ? ~ ! # and everything else.
 */
const ALLOWLIST_RE = /^[A-Za-z0-9 _./:=@+"'-]+$/;

/**
 * Validate a single command-field value.
 * @param {unknown} value
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateCommandString(value) {
  if (value === "") return { ok: true };
  if (typeof value !== "string") return { ok: false, reason: "not a string" };
  if (value.length > 512) return { ok: false, reason: "too long" };
  if (!ALLOWLIST_RE.test(value)) {
    // Find and name the first offending character for a useful error message.
    const offending = [...value].find((c) => !ALLOWLIST_RE.test(c));
    const display = offending === "\n" ? "\\n"
      : offending === "\t" ? "\\t"
      : offending === "\0" ? "\\0"
      : offending;
    return { ok: false, reason: `disallowed character: ${display}` };
  }
  return { ok: true };
}

/**
 * Read a dot-path (e.g. "deploy.staging") from an object.
 * Returns undefined if any intermediate key is missing.
 * @param {object} obj
 * @param {string} dotPath
 * @returns {unknown}
 */
function getByPath(obj, dotPath) {
  return dotPath.split(".").reduce(
    (acc, key) => (acc != null && typeof acc === "object" ? acc[key] : undefined),
    obj,
  );
}

/**
 * Assert all command-producing fields in cfg pass the allowlist.
 * Missing / undefined fields are silently skipped (not yet configured = fine).
 * @param {object} cfg
 * @returns {object} cfg (unchanged) on success
 * @throws {Error} if any command field fails validation
 */
export function assertSafeCommandFields(cfg) {
  for (const path of COMMAND_FIELD_PATHS) {
    const value = getByPath(cfg, path);
    if (value === undefined) continue; // absent → fine
    const result = validateCommandString(value);
    if (!result.ok) {
      throw new Error(
        `untrusted config: ${path} rejected (${result.reason}) — deploy commands must be a single plain invocation; put compound/multi-step deploys in a committed script. See §14 S3.`,
      );
    }
  }
  return cfg;
}

/**
 * Merge a platform (remote) config with the local config, enforcing source-trust rules:
 *   - deploy.*  → ALWAYS from localCfg; platformCfg.deploy is IGNORED (with a stderr warning).
 *   - budgets   → deep-merged, platform overrides local per-key.
 *   - pace      → deep-merged, platform overrides local per-key.
 *   - all other top-level keys → shallow merge (platform overrides local).
 *   - _configSource tag is added.
 *   - assertSafeCommandFields is run on the result (defense-in-depth).
 *
 * @param {object} localCfg
 * @param {object|null|undefined} platformCfg
 * @returns {object}
 */
export function mergePlatformConfig(localCfg, platformCfg) {
  if (!platformCfg) {
    // No platform config — run local through the safety check and return tagged.
    const result = { ...localCfg, _configSource: "local" };
    return assertSafeCommandFields(result);
  }

  // Warn if the platform tried to supply deploy commands (they're silently dropped).
  if (platformCfg.deploy && Object.keys(platformCfg.deploy).length > 0) {
    process.stderr.write(
      "[config-trust] WARNING: platformCfg.deploy is present but will be IGNORED (§14 S3)." +
      " Deploy commands must come from the local config only.\n",
    );
  }

  // Shallow merge of non-command top-level keys, then re-pin command keys from localCfg.
  const { deploy: _platformDeploy, budgets: platformBudgets, pace: platformPace, ...otherPlatform } = platformCfg;
  const { budgets: localBudgets, pace: localPace, ...otherLocal } = localCfg;

  const merged = {
    ...otherLocal,
    ...otherPlatform,
    // Command-producing field: always from local.
    deploy: localCfg.deploy,
    // Policy fields: deep-merge (platform wins per-key).
    ...(localBudgets || platformBudgets
      ? { budgets: { ...localBudgets, ...platformBudgets } }
      : {}),
    ...(localPace || platformPace
      ? { pace: { ...localPace, ...platformPace } }
      : {}),
    _configSource: "platform+local",
  };

  return assertSafeCommandFields(merged);
}
