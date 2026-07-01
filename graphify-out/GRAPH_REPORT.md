# Graph Report - .  (2026-07-01)

## Corpus Check
- 34 files · ~12,943 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 91 nodes · 142 edges · 20 communities (6 shown, 14 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_C0|C0]]
- [[_COMMUNITY_C1|C1]]
- [[_COMMUNITY_C2|C2]]
- [[_COMMUNITY_C3|C3]]
- [[_COMMUNITY_C4|C4]]
- [[_COMMUNITY_C5|C5]]
- [[_COMMUNITY_C6|C6]]
- [[_COMMUNITY_C7|C7]]
- [[_COMMUNITY_C8|C8]]
- [[_COMMUNITY_C9|C9]]
- [[_COMMUNITY_C10|C10]]
- [[_COMMUNITY_C11|C11]]
- [[_COMMUNITY_C12|C12]]
- [[_COMMUNITY_C13|C13]]
- [[_COMMUNITY_C14|C14]]
- [[_COMMUNITY_C15|C15]]
- [[_COMMUNITY_C16|C16]]
- [[_COMMUNITY_C17|C17]]
- [[_COMMUNITY_C18|C18]]

## God Nodes (most connected - your core abstractions)
1. `BoardClient` - 34 edges
2. `assertSafeCommandFields()` - 8 edges
3. `loadConfig()` - 5 edges
4. `validateCommandString()` - 3 edges
5. `mergePlatformConfig()` - 3 edges
6. `decide()` - 3 edges
7. `validateLoadedConfig()` - 3 edges
8. `resolveToken()` - 3 edges
9. `scripts` - 2 edges
10. `COMMAND_FIELD_PATHS` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (20 total, 14 thin omitted)

### Community 0 - "C0"
Cohesion: 0.14
Nodes (11): decide(), DEFAULT_BUDGETS, budgets, cfg, client, now, B, EXAMPLE (+3 more)

### Community 2 - "C2"
Cohesion: 0.20
Nodes (9): author, description, license, name, private, scripts, test, type (+1 more)

### Community 3 - "C3"
Cohesion: 0.54
Nodes (6): assertSafeCommandFields(), COMMAND_FIELD_PATHS, getByPath(), mergePlatformConfig(), validateCommandString(), validateLoadedConfig()

### Community 4 - "C4"
Cohesion: 0.40
Nodes (4): loadConfig(), readJsonIfPresent(), requireToken(), resolveToken()

### Community 6 - "C6"
Cohesion: 0.50
Nodes (3): client, [id, to], r

## Knowledge Gaps
- **34 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+29 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.