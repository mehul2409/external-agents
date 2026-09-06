# pr-impact — closing checkpoint

Final state record for BTW Buildathon Track 3. Narrative, evidence and
citations live in `BUILDATHON.md`; this file records *state*.

Build sequence: initial understanding (`f7f01f0c1f5b`) → pre-noon stable
(`0874724419f8`) → noon Curveball adaptation (`9460153f58dd`) → agentic loop
+ review fixes (this checkpoint).

## Intent

Ship a PR check that reports which **other repositories** a change breaks, for
microservice codebases. Cross-repo edges come from Entire Graph relations that
leave a repo with `relation_scope: "external"` carrying a full module path;
those are resolved against each repo's exported surface, held in a shared
Databricks Delta table, and ranked against intent recorded in Entire
Checkpoints.

## Completed and verified

- **`index` + `analyze` run clean.** `index --repo .` produces 1,160 exported
  symbols / 2,867 external references in ~4.6s, matching the documented table.
- **Cross-repo finding reproduced.** `ParseClaims` in `entireio/auth-go`
  resolves to 5 call sites in `entireio/cli`, each opened and checked against
  source.
- **Databricks verified end-to-end.** With the `cli` shard deleted from the
  local index, so the warehouse is the only possible source of consumer rows,
  the report is identical — all five call sites, same package attribution,
  `388 Databricks row(s)` matched.
- **Precision fixes hold.** Module-path matching (not leaf name) drops Go
  stdlib; package-segment disambiguation collapses three spurious `New`
  findings to the one correct attribution.
- **Degraded modes exercised.** `--no-remote` falls back to local shards and
  the check still runs.
- **Checkpoint capture active.** One checkpoint attached to `db337bd`; the
  `analyze` header reports intent coverage per run.

## Unresolved

- ~~Noon curveball section~~ — done; see BUILDATHON.md.
- ~~Checkpoint links section~~ — done; see BUILDATHON.md.
- `completeness` is per-run, not per-finding: one unreadable transcript demotes
  the entire run to `partial`. Conservative, but it under-claims.
- The `jsonl-v2` vocabulary is fixed to the one published fixture. Event names
  outside it are surfaced as unknown rather than mapped.
- Route/protocol matching (`HANDLES_ROUTE` <-> `HTTP_CALLS`) — the top next
  step; see risk 1.
- Manifest readers beyond `go.mod` (npm, Python).
- Symbol-aware intent extraction to replace substring matching.

## Curveball adaptation (post-noon)

- **Assumption invalidated:** transcript formats are stable and all-or-nothing.
- **Fix:** `ci/pr-impact/lib/transcript.mjs` — one ingestion layer, structural
  format detection (never prose matching), three-state `completeness`
  replacing the binary `available`, unknown events counted and surfaced.
- **The bug it exposed:** `available: resolved > 0` let 3-of-81 resolved
  transcripts justify "never mentioned in checkpoint intent" for 78 unread
  ones, scored at +15. Now demoted and unscored on a partial read.
- **Verified:** 15/15 `node --test`, including a byte-identical regression lock
  against a golden captured from the pre-Curveball implementation.

## Closing state (post-loop review)

- **Agentic loop implemented.** `pr-impact act` = verify -> decide -> act,
  with `lib/gate.mjs` (verification + decision rule) and `lib/notify.mjs`
  (dry-run-by-default consumer notification).
- **31/31 tests passing**, `node --test`, no dependencies, wired into CI.
- **Three silent defects found by review and fixed**, each with a test proven
  to fail without its fix: message-body headings reported as unknown events
  (16 -> 0); transcript bodies truncated to the first line of each turn
  (22% -> 91% of characters captured); verifier confirming symbols that do not
  exist via substring match (now identifier-boundary).
- All three were invisible to `analyze` and surfaced only when the tool was
  asked to act on its own output.

## Technical risks

1. **Protocol-level contracts are not matched.** Only Go module imports are.
   Services coupled by HTTP routes, gRPC, or a subprocess JSON protocol — as
   `external-agents` is to `cli` — produce no module-level edge and are
   therefore invisible to the tool. The graph *does* emit `HANDLES_ROUTE`,
   `HTTP_CALLS` and `HANDLES_GRPC` (confirmed present in the `full` profile),
   and `BOUNDARY_TYPES` scores them higher, but cross-repo route-string
   matching is not implemented. This is the largest gap between the current
   build and the microservice claim in full generality: a clean report is
   evidence about module imports, not about protocol coupling.
2. **Citations point at the enclosing function, not the exact call line.**
   Verified case: graph reports `contexts.go:59`, the `RecordLoginContext`
   declaration; the actual call is line 60. Output is accurate to the
   function, so a reader must open the cited line rather than trust it as the
   call site.
3. **Index freshness is merge-time only.** A repo's surface is republished on
   merge to main, so a consumer that added a call since its last merge is not
   yet indexed and its breakage will not be reported. Publishing from
   unmerged branches is deliberately excluded — the index is shared state and
   doing so would inject false findings into other authors' pull requests.

Secondary, carried from `BUILDATHON.md`: Go-centric module identity;
substring-based intent matching biased toward false negatives (a missed
warning, the wrong direction for a safety tool); `--top` truncation can hide a
low-reach export with a subtle break.
