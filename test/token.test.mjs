import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveToken } from "../skills/yarradev-board-run/scripts/plugin-io.mjs";

// resolveToken reads process.env, so isolate it: clear every YDB_TOKEN* var, set the case's env,
// then restore. (A real YDB_TOKEN in the ambient env must not leak into these assertions.)
function withEnv(env, fn) {
  const saved = Object.entries(process.env).filter(([k]) => k.startsWith("YDB_TOKEN"));
  for (const [k] of saved) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith("YDB_TOKEN")) delete process.env[k];
    for (const [k, v] of saved) process.env[k] = v;
  }
}

test("resolveToken: per-role env wins; hyphen→underscore; falls back to YDB_TOKEN; throws if none", () => {
  withEnv({ YDB_TOKEN_DEVELOPER: "dev.tok", YDB_TOKEN: "shared.tok" }, () => {
    assert.equal(resolveToken("developer"), "dev.tok");   // scoped per-role token wins
    assert.equal(resolveToken("tester"), "shared.tok");   // no scoped token → shared fallback
    assert.equal(resolveToken(null), "shared.tok");       // no role → shared
    assert.equal(resolveToken(undefined), "shared.tok");
  });
  withEnv({ YDB_TOKEN_SECURITY_ADVISOR: "adv.tok", YDB_TOKEN: "shared.tok" }, () => {
    assert.equal(resolveToken("security-advisor"), "adv.tok"); // role name 'security-advisor' → YDB_TOKEN_SECURITY_ADVISOR
  });
  withEnv({ YDB_TOKEN_RELEASER: "rel.tok" }, () => {
    assert.equal(resolveToken("releaser"), "rel.tok");    // scoped token alone is enough (no shared needed)
  });
  withEnv({}, () => {
    assert.throws(() => resolveToken("developer"), /YDB_TOKEN is not set/); // nothing set → fail closed
    assert.throws(() => resolveToken(null), /YDB_TOKEN is not set/);
  });
});
