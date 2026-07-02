#!/usr/bin/env node
/*
 * human-go.mjs <id> — post a production HUMAN_GO (gen-exempt). RUN AS A HUMAN IDENTITY: set YDB_TOKEN to
 * an accountable human's bearer. The board authorizes HUMAN_GO only for a byKind:"human" identity (plus a
 * HUMAN_GO cap) — the orchestrator's agent token is denied, so agents cannot self-approve a release.
 * After this, the next promote MOVE into prod commits. Prints { ok, status, outcome }.
 */
import { makeClient, emit } from "./plugin-io.mjs";

const [id] = process.argv.slice(2);
if (!id) {
  console.error("usage: human-go.mjs <id>");
  process.exit(2);
}
const r = await makeClient({ role: "human" }).humanGo(id);
process.exit(emit(r));
