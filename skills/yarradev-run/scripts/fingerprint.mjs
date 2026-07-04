#!/usr/bin/env node
/*
 * fingerprint.mjs <repo> <file> <summary...> — prints the deterministic bug card id `bug-<fp>` for a
 * reviewer-raised finding.
 *
 * ⚠️ KEY DESIGN CORRECTION (Task A8/U4): an LLM reviewer (e.g. `code-reviewer`) cannot reliably
 * compute a sha256 fingerprint itself. So the reviewer's `spawn[]` entries are RAW —
 * `{title, file, summary, note?}`, no fingerprint — and the CONDUCTOR (SKILL.md's spawn branch) is the
 * one that computes the deterministic id, by shelling out to this script, before it runs the dedup
 * pre-check and `create.mjs --id`.
 *
 * fingerprint = sha256(repo + "\0" + file + "\0" + normalize(summary)).slice(0,16); id = "bug-"+fingerprint.
 * Delegates to the vendored core's `bugFingerprint`/`bugCardId` (./vendor/core.mjs), which mirrors
 * packages/orchestrator-core/src/fingerprint.ts verbatim — see spec §4,
 * docs/superpowers/specs/2026-07-05-auto-raised-bug-cards-design.md.
 *
 * Prints just the id (`bug-<16hex>`) to stdout — this is a pure computation, not a board act, so
 * there's no gen/act JSON envelope to emit.
 *
 * Usage: node fingerprint.mjs <repo> <file> <summary...>  (summary = every arg after <file>, joined
 * with a space). Exit 0 on success; exit 2 on a usage error (missing repo/file/summary), matching the
 * other CLI scripts' argv-contract style.
 */
import { bugFingerprint, bugCardId } from "./vendor/core.mjs";

/**
 * Compute the deterministic bug-card id for a (repo, file, summary) triple.
 * @param {string} repo
 * @param {string} file
 * @param {string} summary
 * @returns {Promise<string>} "bug-<16hex>"
 */
export async function runFingerprint(repo, file, summary) {
  const fp = await bugFingerprint(repo, file, summary);
  return bugCardId(fp);
}

// CLI: only execute when invoked directly (`node fingerprint.mjs <repo> <file> <summary...>`), NOT on
// import — the unit test imports runFingerprint and must not shell out.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [repo, file, ...rest] = process.argv.slice(2);
  if (!repo || !file || rest.length === 0) {
    console.error("usage: fingerprint.mjs <repo> <file> <summary...>");
    process.exit(2);
  }
  const id = await runFingerprint(repo, file, rest.join(" "));
  process.stdout.write(id + "\n");
  process.exit(0);
}
