# Epic-scoped context clearing + card priority

**Status:** design · **Date:** 2026-07-06

## Overview

The yarradev orchestrator loop (`/loop 5m /yarradev:yarradev-run`) accumulates all
conversation context across every pass — dispatch logs, verdict parsing, script stdout.
After processing one epic end-to-end, the context window is stuffed with stale history
that wastes tokens and pollutes the model's attention for the next epic.

This feature introduces two intertwined changes:

1. **Card priority** — a `priority` field on cards so the conductor always picks the
   highest-priority epic, and the highest-priority story within it.
2. **Epic-scoped context clearing** — after an epic drains (all children terminal +
   `epic_integrating→epic_done`), the conductor exits with a signal file. A wrapper
   script restarts the session with clean context. A context-pressure safety valve
   triggers the same restart mid-epic if the window fills before completion.

## Card priority model

### Data model

New `priority` field on card `data`:

| Field | Type | Default | Semantics |
|---|---|---|---|
| `priority` | integer | 50 (epic), 100 (story) | Lower = higher priority |

Bugs inherit priority from their parent card and are not independently prioritised.

### Sort order

`list-ready.mjs` produces a scored list:

1. Group ready cards by their **root epic** (walk `parent_id` until `type === "epic"`).
   Cards with no epic parent form a single "standalone" group.
2. Order groups by the **epic's priority** ascending.
3. Within each group, order children by **their own priority** ascending, then by
   creation time (FIFO) as tiebreaker.
4. No cross-epic interleaving — finish one epic before starting the next.

Standalone stories/bugs (no parent epic) are picked by their own priority, FIFO tiebreak,
and do NOT trigger context clearing on completion.

### Defaults rationale

- Epic default 50, story default 100: epics are picked before standalone stories unless
  explicitly reordered. This means "if you have an epic, work on it first" is the default
  without requiring every epic to be explicitly ranked.
- A user who wants equal priority sets all epics to 100 and all stories to 100.
- Priority is set at CREATE time (via `--priority <n>` on `create.mjs`). Changing it
  post-creation is a board-side `UPDATE` act (future scope — v1 relies on initial set).

## Epic completion detection

### Trigger

The conductor detects epic completion when a `promote` act for an epic card commits
with `state: "epic_integrating"` and `to: "epic_done"`. This means the barrier gate
cleared — all child stories are terminal (prod / epic_done).

### Conductor sequence on epic completion

1. Post the `promote` MOVE (already in SKILL.md's promote branch).
2. Detect it was an epic barrier clearing: the card's `type === "epic"` and the
   transition is `epic_integrating → epic_done`.
3. Gather summary data from the card enrichment: `children_total`, `title`, current time.
4. Write `/tmp/yarradev-epic-done`:
   ```json
   {
     "epicId": "epic-abc123",
     "title": "SSO migration",
     "completedAt": "2026-07-06T05:30:00Z",
     "storyCount": 5,
     "bugCount": 2
   }
   ```
5. Call `/exit` (exit code 0).

### Clean-exit contract

| Exit path | Code | Wrapper action |
|---|---|---|
| Epic completion | 0 + signal file present | Log summary, restart immediately |
| `/exit` called without signal file | 0, no signal | Restart after 30s delay (unexpected) |
| Crash / kill | non-zero | Restart after 30s delay |
| Context-pressure clear | 0 + signal file present | Log partial summary, restart immediately |

### What does NOT trigger a clear

- A story/bug reaching prod (only epic boundaries clear context).
- A human-GO promote (staging→prod is NOT an epic completion).
- Any reject / escalate / hold — the loop continues normally.

## Context clearing mechanism

### Signal file contract

The plugin writes to `/tmp/yarradev-epic-done`. It reads `/tmp/yarradev-prep-clear`.
Both are well-known paths with no configuration needed. They are the ONLY interface
between the plugin and external infrastructure.

### Epic completion (primary trigger)

```
Conductor: promote epic_integrating → epic_done commits
         → write /tmp/yarradev-epic-done
         → /exit
Wrapper:  detect signal file
         → read summary, append to /tmp/yarradev-epic-log
         → rm signal file + prep-clear flag
         → claude-bg stop --name yarradev
         → claude-bg start --tmux --name yarradev
         → attach → new session starts with clean context
```

### Context pressure (safety valve)

```
Statusline: Claude Code calls statusline.sh with session JSON
          → echo $CTXPCT > /tmp/yarradev-ctx-pct   # one-line addition
Wrapper:  poll /tmp/yarradev-ctx-pct every 5s
          → if ≥ 60%: touch /tmp/yarradev-prep-clear
Conductor: top of each pass, check /tmp/yarradev-prep-clear
          → if exists: finish current story (don't start new one)
          → write partial /tmp/yarradev-epic-done
          → /exit
```

The prep-clear flag is a soft signal — the conductor finishes in-flight work but
doesn't claim a new card. The epic's remaining stories resume after restart (the
board state is unchanged; the next session's conductor picks up the epic again).

### What about non-epic cards mid-flight?

If the prep-clear flag fires while processing a standalone story (no parent epic):
finish it and exit. No signal file is written (there's no epic to summarise). The
wrapper detects claude exited cleanly without a signal file and restarts after 30s.

## yarradev-loop wrapper

### Location

`~/work/tools/yarradev-loop` — external to both the plugin repo and the platform repo.
Not shipped with the plugin. The plugin works without it (exits cleanly; user restarts
manually).

### Behaviour

```bash
#!/bin/bash
# yarradev-loop — epic-boundary context-clearing wrapper for the yarradev orchestrator.
# Uses claude-bg for tmux session management.
set -euo pipefail

SIGNAL_FILE="/tmp/yarradev-epic-done"
PREP_CLEAR="/tmp/yarradev-prep-clear"
CTX_FILE="/tmp/yarradev-ctx-pct"
LOG_FILE="/tmp/yarradev-epic-log"
CTX_THRESHOLD=60
POLL_INTERVAL=5
RESTART_DELAY=30
SESSION_NAME="yarradev"

# Ensure clean start
rm -f "$SIGNAL_FILE" "$PREP_CLEAR"

while true; do
  # Start session
  claude-bg start --tmux --name "$SESSION_NAME"
  claude-bg attach --name "$SESSION_NAME" &
  ATTACH_PID=$!

  # Watch loop
  while true; do
    # --- Epic completion ---
    if [ -f "$SIGNAL_FILE" ]; then
      echo "[yarradev-loop] Epic completed:"
      cat "$SIGNAL_FILE" | tee -a "$LOG_FILE"
      rm -f "$SIGNAL_FILE" "$PREP_CLEAR"
      break
    fi

    # --- Context pressure ---
    CTX=$(cat "$CTX_FILE" 2>/dev/null || echo 0)
    if [ "$CTX" -ge "$CTX_THRESHOLD" ] 2>/dev/null; then
      if [ ! -f "$PREP_CLEAR" ]; then
        echo "[yarradev-loop] Context at ${CTX}% — signalling prep-clear"
        touch "$PREP_CLEAR"
      fi
    fi

    sleep "$POLL_INTERVAL"
  done

  # Restart
  claude-bg stop --name "$SESSION_NAME" 2>/dev/null || true
  echo "[yarradev-loop] Restarting with clean context..."
done
```

### Dependencies

- `claude-bg` (already in `~/work/tools/`)
- `tmux`
- `/tmp/yarradev-ctx-pct` populated by the user's statusline.sh (one-line addition)

## Context pressure publishing (user infrastructure)

The user adds one line to their platform statusline (`platform/.claude/statusline.sh`):

```bash
echo "$CTXPCT" > /tmp/yarradev-ctx-pct
```

This is NOT part of the plugin — it's a user-side customisation of their statusline.
Without it, the wrapper has no CTX% signal; the pass-count fallback (see below) still
protects against unbounded context growth.

### Fallback: pass-count safety valve

If `/tmp/yarradev-ctx-pct` is absent (no statusline integration), the conductor
increments a pass counter in `/tmp/yarradev-epic-pass-count` each yield. When the
count exceeds a hardcoded threshold (default: 40 passes, ~3.3 hours at 5-min loop
interval), the conductor writes `/tmp/yarradev-prep-clear` itself and finishes up.
This ensures unbounded epics don't silently fill the window even without the
statusline integration.

## Plugin-side changes

### SKILL.md

1. **Priority sort order** — step 1 (`list-ready`) now documents the two-level
   sort: epic priority → story priority → FIFO.

2. **Prep-clear check** — at the top of step 2 (before claiming a card), the
   conductor checks for `/tmp/yarradev-prep-clear`. If present and the current
   story is done, it writes a partial `/tmp/yarradev-epic-done` (epic not
   completed, but all in-flight work is done) and calls `/exit`.

3. **Epic completion sequence** — the promote branch for epic barriers now
   includes: detect epic completion → write signal file → `/exit`.

4. **Discipline rule** — "process stories within the current epic in priority
   order. Do not pick up a story from a different epic while the current epic
   has ready work."

### create.mjs

New flag: `--priority <n>` (integer, default: 100 for story/bug, 50 for epic).

```
create.mjs "OAuth flow" --type story --parent epic-sso --priority 1
create.mjs "SSO migration" --type epic --priority 10
```

### list-ready.mjs

Sort logic changes:
- New scoring: `(epic_priority, card_priority, created_at)`
- Epics themselves appear as actionable when in `epic_analysis` state (analyst
  pickup). Their priority determines which epic is picked first.

### Other scripts

No changes to `move.mjs`, `reject.mjs`, `link-pr.mjs`, `push.mjs`, `claim.mjs`,
`clear-lease.mjs`, `promote.mjs`, `release.mjs`, `escalate.mjs`, etc. The
priority and context-clearing logic lives entirely in `list-ready.mjs` (sort),
`create.mjs` (set), and `SKILL.md` (conductor behaviour).

## Architecture

```
┌─ statusline.sh (user-owned, platform/.claude/) ──┐
│  echo "$CTXPCT" > /tmp/yarradev-ctx-pct            │
└────────────────────────────────────────────────────┘
                         │
                         ▼ /tmp/yarradev-ctx-pct
┌─ yarradev-loop (user-owned, ~/work/tools/) ───────┐
│  Polls ctx-pct → touch prep-clear if ≥ 60%          │
│  Watches epic-done signal → stop + restart session  │
└────────────────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼ /tmp/yarradev-prep-clear    ▼ /tmp/yarradev-epic-done
┌─ Plugin (shipped, marketplace) ────────────────────┐
│  SKILL.md: check prep-clear each pass               │
│           detect epic completion                    │
│           write signal file, /exit                  │
│  list-ready.mjs: priority sort                      │
│  create.mjs: --priority flag                        │
└────────────────────────────────────────────────────┘
```

Clean separation:
- **Plugin** — priority, epic detection, signal file write, prep-clear check.
  Works standalone (without wrapper, the user restarts manually).
- **yarradev-loop** — watches signals, manages session lifecycle. Not shipped.
- **statusline** — publishes CTX% to tmp file. User customisation, not shipped.

## Non-goals (v1)

- Changing priority post-creation (board-side UPDATE act — future scope).
- Cross-epic parallelism (v1 is single-threaded, `maxCardsPerPass: 1`).
- Context clearing for standalone stories (only epic boundaries).
- Pass-count threshold configurability (hardcoded at 40; future `board.json` field).
- The statusline CTX% line shipping with the plugin (user infrastructure only).
