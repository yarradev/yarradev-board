/*
 * Guard: no advisor with `authority: veto` frontmatter is configured to a cheapest-tier model.
 * Generalizes yanyja's `legal-advisor: haiku` slip (a veto-authority advisor silently downgraded to
 * the cheapest model tier, weakening review quality on exactly the stage meant to catch high-stakes
 * mistakes). Advisor `model`/`authority` live in agents/*.md YAML frontmatter (e.g.
 * security-advisor.md:5,9) — this is the plugin-repo guard because the platform repo can't see this
 * repo's agent files. Fails CLOSED: an agent file that can't be parsed, or is missing frontmatter it's
 * expected to declare, is treated as a violation, not skipped.
 *
 * "Cheapest tier" = CHEAPEST_TIER_MODELS below — a small deny-list of cheapest-class model
 * identifiers (matched case-insensitively as a substring of the `model:` value), not an allowlist of
 * "acceptable" models. Extend the deny-list, don't invert it into an allowlist, if a new cheap tier
 * ships (e.g. a future "claude-haiku-5" or a non-Anthropic cheapest-tier id would still match via
 * substring "haiku"; a genuinely new cheap family needs a new entry here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));

// Cheapest-tier model identifiers — deny-list, matched case-insensitively as a substring of `model:`.
const CHEAPEST_TIER_MODELS = ["haiku"];

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue; // skips blank lines and `# comment` lines (no leading key:)
    let [, key, value] = kv;
    value = value.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    fm[key] = value;
  }
  return fm;
}

function isCheapestTier(model) {
  if (!model) return false;
  const lower = String(model).toLowerCase();
  return CHEAPEST_TIER_MODELS.some((cheap) => lower.includes(cheap));
}

function loadAgents() {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(path.join(AGENTS_DIR, f), "utf8");
      return { file: f, frontmatter: parseFrontmatter(text) };
    });
}

test("no-cheap-model-on-veto: every shipped agent has parseable frontmatter with model + authority", () => {
  const agents = loadAgents();
  assert.ok(agents.length > 0, "expected at least one agents/*.md file");
  for (const { file, frontmatter } of agents) {
    assert.ok(frontmatter, `${file}: missing/malformed YAML frontmatter (expected a leading --- block)`);
    assert.ok(frontmatter.model, `${file}: frontmatter missing 'model'`);
    assert.ok(frontmatter.authority, `${file}: frontmatter missing 'authority'`);
  }
});

test("no-cheap-model-on-veto: no veto-authority advisor is configured to a cheapest-tier model", () => {
  const agents = loadAgents();
  const vetoAgents = agents.filter((a) => a.frontmatter?.authority === "veto");
  assert.ok(vetoAgents.length > 0, "expected at least one veto-authority agent (security-advisor) to guard");
  for (const { file, frontmatter } of vetoAgents) {
    assert.ok(
      !isCheapestTier(frontmatter.model),
      `${file}: authority:veto advisor is configured to cheapest-tier model '${frontmatter.model}' — ` +
        `veto authority must not run on the cheapest model tier (generalizes the legal-advisor:haiku slip)`,
    );
  }
});
