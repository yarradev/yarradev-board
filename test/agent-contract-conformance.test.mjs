/*
 * agent-contract-conformance.test.mjs — GH #97.
 *
 * The verdict shape is written down TWICE, and nothing checked the two against each other:
 *   1. agents/*.md — what the dispatched model is told to emit (shipped by this plugin)
 *   2. routeVerdict (pass.mjs) — what the conductor actually reads
 *
 * Every drift between them is silent by construction: the agent complies with its own contract, the
 * conductor reads a field that isn't there, and the payload is dropped with no error anywhere. That is
 * how #92 happened — four agent docs put a question in `summary`, routeVerdict read `reason ?? question`,
 * and every question parked as content-free. It was diagnosed as a misbehaving agent for six days.
 *
 * This test mechanises the contract: it parses every fenced JSON verdict example out of agents/*.md,
 * drives routeVerdict with sentinel values, and asserts each declared field's value actually reaches an
 * act. A field the conductor deliberately ignores must be named in NOT_FORWARDED with a reason — so
 * dropping a field is a decision someone writes down, not an accident nobody notices.
 *
 * Scope: top-level scalar fields. Structured payloads (evidence{} on submitted, children[], spawn[]) have
 * dedicated tests in pass-routing.test.mjs; here they are walked for leaf strings where the branch
 * forwards them as act args, and skipped otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { routeVerdict } from "../skills/yarradev-run/scripts/pass.mjs";

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/**
 * Fields the conductor knowingly does not forward. Each entry is a deliberate decision with a reason —
 * NOT a licence to ignore new drift. Adding to this list should require the same scrutiny as fixing it.
 */
const NOT_FORWARDED = {
  to: "structural, not payload: the conductor derives the edge from the lifecycle (advance) or the compiled machine (advisor reject). On a WORKER reject it IS forwarded, as the target argument.",
};

/**
 * Turn a doc example's placeholders into parseable JSON:
 *   "<one line>" → "__PH__" · bare <n> → 42 · trailing `, ...` (the docs' "and so on" marker) → dropped.
 */
function parseExample(line) {
  const normalized = line
    .replace(/:\s*<[^>"]*>/g, ": 42") // bare numeric placeholder, e.g. "pr_number": <n>
    .replace(/"<[^>]*>"/g, '"__PH__"')
    .replace(/,\s*\.\.\.\s*(?=[\]}])/g, "") // […, ...] → […]
    .replace(/,\s*(?=[\]}])/g, ""); // any resulting trailing comma
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

/**
 * Replace every string leaf with a unique, greppable sentinel so we can trace it into the act args.
 * `status` is preserved verbatim — it selects the branch under test rather than being payload.
 */
function sentinelize(obj, path = []) {
  if (typeof obj === "string") return `SENTINEL_${path.join("_") || "root"}`;
  if (Array.isArray(obj)) return obj.map((v, i) => sentinelize(v, [...path, String(i)]));
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, k === "status" ? v : sentinelize(v, [...path, k])]),
    );
  }
  return obj;
}

/** Every fenced verdict example across the shipped agent docs, single- or multi-line. */
function collectExamples() {
  const out = [];
  for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"))) {
    const lines = readFileSync(join(AGENTS_DIR, file), "utf8").split("\n");
    let start = null;
    let buf = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (start === null) {
        if (t.startsWith("```")) { start = i + 2; buf = []; }
        continue;
      }
      if (t.startsWith("```")) {
        const body = buf.join("\n").trim();
        if (body.startsWith("{") && /"status"\s*:/.test(body)) {
          const parsed = parseExample(body);
          if (parsed?.status) out.push({ file, line: start, verdict: parsed });
        }
        start = null;
        continue;
      }
      buf.push(lines[i]);
    }
  }
  return out;
}

/** A ctx plausible for the status under test — the conductor's own dispatch context, not the verdict's. */
function ctxFor(status, verdict) {
  const base = { id: "c1", gen: 5, kind: "work" };
  if (status === "advice" || status === "clean" || status === "veto" || status === "hold") {
    return { ...base, state: "test", role: "code-reviewer", to: "done" };
  }
  if (status === "decomposed") {
    return { ...base, state: "epic_decompose", role: "analyst", to: "epic_integrating", type: "epic" };
  }
  if (status === "submitted") return { ...base, state: "dev", role: "developer", to: "test" };
  return { ...base, state: "dev", role: "developer", to: verdict.to ?? "test" };
}

const MACHINE = {
  transitions: [
    { from: "dev", to: "spec", type: "REJECT" },
    { from: "test", to: "dev", type: "REJECT" },
  ],
};

async function actsFor(verdict, ctx) {
  const acts = [];
  await routeVerdict({
    verdict,
    ctx,
    lifecycle: {},
    machine: MACHINE,
    run: async (script, args) => {
      acts.push({ script, args });
      if (script === "fingerprint.mjs") return { id: "bug-1", ok: true };
      return { ok: true };
    },
    dispatch: async () => {},
    getCard: async () => null,
    buildAdvisorPrompt: async () => "/tmp/p",
  });
  return acts;
}

const EXAMPLES = collectExamples();

test("conformance: the agent docs actually contain verdict examples to check", () => {
  // Guards against the whole suite silently passing because the extraction broke.
  assert.ok(EXAMPLES.length >= 15, `expected the shipped agent docs to declare many verdicts, found ${EXAMPLES.length}`);
  const statuses = new Set(EXAMPLES.map((e) => e.verdict.status));
  for (const s of ["advance", "reject", "question", "submitted", "clean", "advice", "veto", "hold", "decomposed"]) {
    assert.ok(statuses.has(s), `no agent doc declares a ${s} verdict — extraction likely broke`);
  }
});

for (const { file, line, verdict } of EXAMPLES) {
  const status = verdict.status;
  const declared = Object.entries(verdict).filter(([k, v]) => k !== "status" && typeof v === "string");
  if (declared.length === 0) continue;

  test(`conformance: ${file}:${line} — every field declared for \`${status}\` reaches an act`, async () => {
    const sentinel = sentinelize(verdict);
    const acts = await actsFor(sentinel, ctxFor(status, verdict));
    const seen = JSON.stringify(acts);

    for (const [field] of declared) {
      if (NOT_FORWARDED[field]) continue;
      assert.ok(
        seen.includes(`SENTINEL_${field}`),
        `${file}:${line} tells the agent to send \`${field}\` on a ${status} verdict, but routeVerdict never ` +
          `forwards it — the value is silently dropped. Either read it, or add it to NOT_FORWARDED with a ` +
          `reason.\n  acts: ${seen}`,
      );
    }
  });
}
