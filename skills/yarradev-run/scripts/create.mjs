#!/usr/bin/env node
/*
 * create.mjs <title...> [--id <id>] [--type story|epic] [--state <s>] [--parent <id>] [--priority <n>] [--lane fast|full] [--depends-on <csv>] [--role <r>]
 *   — mint a new card via a gen-exempt CREATE (Phase 2b Task 6). This is the LIVE production path for
 *   epic decomposition (an analyst fans an epic out into child story cards): SKILL.md's "decomposed"
 *   branch calls this script once per child. reduce()'s "decomposed" case in orchestrator-core is NOT
 *   this path — it exists only for Verdict-union shape-completeness (see reduce.ts's doc comment).
 *
 * <title...> — everything not consumed by a flag is joined with a space and used as the card title.
 *   A missing/blank title is a usage error (exit 2), matching the other CLI scripts' argv-contract style.
 *
 * --id <id>      explicit item_id; default crypto.randomUUID() (the board REJECTS an empty item_id on
 *                CREATE — storage.ts:1877-1878 — so an id is ALWAYS minted, never left blank).
 * --type <t>     data.type, default "story" (board default when omitted is also "story").
 * --state <s>    data.state; omit entirely to let the board default to "backlog" (storage.ts:715).
 * --parent <id>  data.parent_id — the epic this child belongs to (wires parent-of + children_total).
 * --lane fast|full  convenience alias for --state: full→"spec" (design gate first), fast→"dev" (skip
 *                straight to development). --lane and --state are MUTUALLY EXCLUSIVE; if both are
 *                given, --lane WINS (documented, not an error) — --state is silently ignored.
 * --depends-on <csv>  comma-separated dependency cardIds → data.depends_on (GH #32). The card is not
 *                actionable until each dep reaches `done` (enforced by the board's projection once the
 *                dependency model ships; until then this is stored on the act but not folded — a no-op).
 *                A child may reference siblings created in the same decompose batch.
 * --role <r>     acting board identity for the CREATE post, default "analyst" (cockpit/human creates
 *                go through the dashboard, not this script).
 *
 * Prints { ok, status, outcome, id } (id always present so a caller can thread it into further calls,
 * e.g. as --parent for a grandchild). Exit 0 on committed, 1 otherwise, 2 on usage error.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const LANE_STATE = { fast: "dev", full: "spec" };

function parseArgs(argv) {
  const titleParts = [];
  const opts = { id: undefined, type: undefined, state: undefined, parent: undefined, priority: undefined, lane: undefined, dependsOn: undefined, role: "analyst" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--id":
        opts.id = argv[++i];
        break;
      case "--type":
        opts.type = argv[++i];
        break;
      case "--state":
        opts.state = argv[++i];
        break;
      case "--parent":
        opts.parent = argv[++i];
        break;
      case "--priority":
        opts.priority = parseInt(argv[++i], 10);
        if (isNaN(opts.priority)) {
          console.error(`usage: --priority must be an integer, got '${argv[i]}'`);
          process.exit(2);
        }
        break;
      case "--lane":
        opts.lane = argv[++i];
        break;
      case "--depends-on":
        opts.dependsOn = argv[++i];
        break;
      case "--role":
        opts.role = argv[++i];
        break;
      default:
        titleParts.push(a);
    }
  }
  opts.title = titleParts.join(" ").trim();
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.title) {
  console.error(
    "usage: create.mjs <title...> [--id <id>] [--type story|epic] [--state <s>] [--parent <id>] [--priority <n>] [--lane fast|full] [--depends-on <csv>] [--role <r>]",
  );
  process.exit(2);
}

// --lane wins over --state when both are given (documented, not a usage error).
const state = opts.lane ? LANE_STATE[opts.lane] : opts.state;
if (opts.lane && !state) {
  console.error(`usage: --lane must be 'fast' or 'full', got '${opts.lane}'`);
  process.exit(2);
}

const id = opts.id ?? crypto.randomUUID();
const resolvedType = opts.type ?? "story";
const defaultPriority = resolvedType === "epic" ? 50 : 100;
const data = { type: resolvedType, title: opts.title, priority: opts.priority ?? defaultPriority };
if (state) data.state = state;
if (opts.parent) data.parent_id = opts.parent;
// depends_on: CSV → trimmed, de-duped, non-empty array. Forward-compatible — the board stores it on the
// act now and folds it into item.depends_on once the dependency model ships (GH #32).
if (opts.dependsOn) {
  const deps = [...new Set(opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean))];
  if (deps.length) data.depends_on = deps;
}

const client = makeClient({ role: opts.role });
const r = await client.create(id, data);
process.exit(emit(r, { id }));
