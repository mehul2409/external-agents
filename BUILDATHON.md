# pr-impact

## One-sentence summary

A pull-request check for microservice codebases that reports which **other
repositories** a change breaks, resolved from Entire Graph's cross-repo
relations and ranked against the intent recorded in Entire Checkpoints.

## Problem, intended user and why it matters

The intended user is a developer merging a change into one service of a
multi-repo estate.

Every code-intelligence tool available today is **single-repo**. `git diff`
shows changed lines. `entire graph impact` shows the blast radius *inside this
repository*. Both go quiet at the repository boundary — which is exactly where
microservice breakage lives.

The failure mode is concrete: you change an exported function's signature in a
shared library or service. Your repo's tests pass, your review is clean, your
blast radius looks small. Four other services call that function. Nobody finds
out until deploy.

This is not a hypothetical. Running the tool against real Entire repositories:

> `ParseClaims` changed signature in `entireio/auth-go` at `tokens/tokens.go:137`.
> It is called from **five sites in `entireio/cli`** — `auth/contexts.go:59`,
> `auth/contexts.go:173`, `auth/env_token.go:64`, `login.go:472`, `login.go:512`.

No single-repo tool reports that, because no single-repo tool can see it.

## Selected Entire track and why Entire is essential

**Track 3 — Bring Entire to a New Agent or Workflow**
(repository: `entireio/external-agents`), addressing the track's second listed
example: *a CI or pull-request workflow that uses checkpoint context.*

Entire is load-bearing on both sides, and the design is derived from its data
model rather than bolted onto it:

- **Graph.** The cross-repo join is only possible because the graph already
  emits relations that leave a repository with `relation_scope: "external"` and
  an unresolved target carrying the **full module path** —
  `external:symbol:github.com/entireio/auth-go/tokens.ParseClaims`. That
  dangling edge is one half of a cross-repo contract; another repo's exported
  surface is the other half. The product is the resolution between them. No
  other tool in the stack emits that edge.
- **Checkpoints.** Ranking needs to know which consumers the author actually
  considered. Checkpoint intent supplies it, so a change whose author never
  mentions a downstream service ranks above one where they did.

Remove either and the product collapses: without the graph there are no
cross-repo edges to resolve; without checkpoints every consumer looks equally
unexamined.

## Architecture and main workflow

```
  ┌─────────────── per repo, on merge to main ───────────────┐
  │  entire graph symbols  → exported surface (what we PROVIDE)
  │  entire graph edges    → relation_scope=external
  │                          (what we CONSUME, with module path)
  │                                   │
  │                                   ▼
  │                    Databricks Delta: service_surface
  └───────────────────────────────────────────────────────────┘
                                      │
  ┌─────────────── per pull request ──┼───────────────────────┐
  │  entire graph diff  → changed exports in THIS repo        │
  │                                   ▼                       │
  │  SELECT ... WHERE target IN (...) → consumers in OTHER    │
  │                                     repos                 │
  │                                   │                       │
  │  entire checkpoint explain --commit → stated intent       │
  │                                   ▼                       │
  │  rank → markdown comment on the PR, every claim cited     │
  └───────────────────────────────────────────────────────────┘
```

Components, all in this fork:

| Path | Role |
| --- | --- |
| `ci/pr-impact/bin/pr-impact.mjs` | `index` and `analyze` commands |
| `ci/pr-impact/lib/databricks.mjs` | Shared index over the SQL Statement Execution API |
| `ci/pr-impact/lib/transcript.mjs` | Single ingestion layer: detect → parse → normalize, for both transcript formats |
| `ci/pr-impact/test/` | `node --test` suite; fixtures include the agent's real session |
| `ci/pr-impact/pr-impact.yml` | Workflow: analyze on PR, publish on merge |

### Design decisions, and what forced them

**Match on module path, not symbol name.** The first working version matched
external targets by leaf name and produced 30 "cross-repo dependencies"
between `cli` and `external-agents` — of which essentially all were Go stdlib
(`MkdirAll`, `Marshal`, `Errorf`, `WriteFile`). Any repo defining a symbol
called `New` would appear to own every consumer of every `New` in the estate.
Matching the full module path fixed it, and stdlib falls out for free: `os`
and `fmt` prefix no indexed module.

**Disambiguate by package segment.** Module-path matching still reported
`authcode.New`, `crossjuris.New` and `deviceflow.New` as three findings
pointing at the same two call sites. Requiring the consumer path's package
segment to match the changed symbol's own directory reduced this to the one
correct attribution.

**Publish on merge, never on the PR.** The index is shared state. Publishing
from an unmerged branch would advertise contracts that do not exist yet and
would produce false findings in *other people's* pull requests.

**Delete-then-insert per repo, not append.** A re-index after merge must
replace that repo's rows, or stale contracts accumulate and the tool reports
breakage against code that no longer exists.

## Entire Graph findings and verification

Indexed surfaces, all real repositories:

| Repo | Exported symbols | External references |
| --- | --- | --- |
| `gh/entireio/cli` | 12,932 | 38,197 |
| `gh/entireio/auth-go` | 385 | 933 |
| `local/external-agents` | 1,160 | 2,867 |

`entireio/cli` indexes to 1,425 files / 28,563 symbols / 160,170 relations,
`completeness_level: ok`.

**Graph search and definition lookup.** `entire graph symbols` supplies the
provided surface; `entire graph edges` supplies external references with
`relation_scope`, `confidence` and `warning_codes`.

**Relationship / impact analysis before a high-risk change.** The
`ParseClaims` finding above: a `signature_changed` export in `auth-go`
resolving to five call sites in a different repository.

**Verified against source, not taken on trust.** Each claim was opened and
checked:

- `demo-auth/tokens/tokens.go:137` →
  `func ParseClaims(jwt string) (*UnverifiedClaims, error)` ✓
- `demo-cli/cmd/entire/cli/auth/contexts.go` → calls
  `tokens.ParseClaims(rawToken)` ✓
- **Discrepancy found and recorded:** the graph cites line **59**, which is
  the `func RecordLoginContext(...)` declaration; the actual call is on line
  **60**. Citations resolve to the *enclosing function*, not the exact call
  line. The tool's output is therefore accurate to the function, and the
  skill's instruction to open the cited line before acting is what catches
  the difference. This is documented rather than smoothed over.

**A negative result, also verified.** `external-agents` shows **zero**
module-level dependencies on `cli`. That is correct: external agents
communicate with the CLI over a JSON stdin/stdout subprocess protocol, not Go
imports. The tool reporting nothing there is right, and protocol-level
contracts are a known gap (see limitations).

## Noon Curveball: what changed and how we adapted

**Track 3 — "The Agent Changed Its Format."** The integrated agent released a
new transcript and lifecycle event format; existing users still emit the
original one. Both must work, unknown events must not crash the check, and an
incomplete transcript must yield a PARTIAL result rather than a discarded or
corrupted session.

### The assumption that broke

We had assumed the formats we consume are **stable and all-or-nothing**. That
assumption was load-bearing in three places in `ci/pr-impact/bin/pr-impact.mjs`,
and all three were wrong:

1. **Readability was decided by matching English prose.** `checkpointIntent`
   tested the CLI's output against `/No associated Entire checkpoint/` and
   `/checkpoint not found/`. A wording change upstream — or a localized build —
   would silently flip "unreadable" to "readable" and let a *failure message*
   be scored as author intent.
2. **Tier-2 intent parsed a human-rendered table.** The fallback mined
   `entire checkpoint list` with a layout regex over date/time columns. That is
   a presentation surface, not a contract.
3. **`ndjson()` swallowed malformed lines and ignored `schema_version`.** A
   schema shift would present as a *smaller graph*, not as an unreadable one.

### The bug this exposed, which is the real finding

`checkpointIntent` returned `available: resolved > 0` — a **binary** flag. On
our own demo run, intent resolved for **3 of 81 commits**. Because `available`
was then true, `analyze` computed "repos not mentioned in the intent text" over
the 3 transcripts we could read, and reported consumer repos as
**"Never mentioned in checkpoint intent"** while **78 transcripts went unread**.
That claim then added a real **+15 to the risk score**.

We were presenting partial context as authoritative and manufacturing findings
from the gap. The header already printed `3/81` honestly — the number was right
there and simply was not wired to the claim. For a tool whose entire thesis is
*"the author never considered this consumer,"* absence of evidence was being
reported as evidence of absence. The Curveball forbids exactly this.

### How the design changed

A single ingestion layer, `ci/pr-impact/lib/transcript.mjs`. Per-format code
exists in exactly one place and nothing downstream can see a format:

```
  raw → detectFormat()  → 'legacy-text' | 'jsonl-v2' | 'unknown'
      → parse<format>() → the ONLY per-format code
      → normalize()     → { events, unknownEvents[], completeness, resolved, total }
```

The pipeline is **not** forked per format. `analyze`, the scorer and both
renderers consume the normalized shape only.

**Detection is structural, never prose.** `detectFormat` keys on document
structure — box-drawing rules, `## Intent` headings, `[User]`/`[Assistant]`
markers, or a majority of lines being JSON objects with a discriminator. The
test suite proves this by rewording the CLI's failure message into German and
asserting it is *still* classified `unknown`.

**Binary `available` replaced by three-state `completeness`:**

| State | Meaning | What may be claimed |
| --- | --- | --- |
| `complete` | every commit in range resolved to an intact transcript | "Never mentioned in checkpoint intent" — scored, +15 |
| `partial` | some resolved, or a resolved one was damaged | **demoted**: "not found in the N of M transcripts that were readable" — reported, **not scored** |
| `unavailable` | none resolved | structural findings only (unchanged behaviour) |

The demotion is the point. On a partial read the observation still appears —
suppressing it entirely would hide real risk — but it is stated as a fact about
*our reading*, not about the author, and it contributes nothing to the score.
A finding that scored 53 on a complete read scores 38 on a partial one, and the
15-point difference is precisely the claim we can no longer support.

Note that a **truncated** transcript keeps a run at `partial` even when every
commit resolved: full count with damaged content is not completeness.

**Unknown events are counted and surfaced, never fatal.** An unrecognised event
type contributes no text — an event we did not understand must not influence a
finding it was not understood well enough to support — and it is reported in the
PR comment (`4 unrecognised checkpoint event(s) ignored: \`permission_mode\` x2, …`).

**`ndjson()` now counts malformed lines and reads `schema_version`**, warning on
stderr when a stream is newer than the build understands. The run proceeds — a
partial graph beats no check — but it no longer passes unnoticed.

### One thing the fixture corrected

Before the official fixture arrived we modelled `jsonl-v2` on the live
Entire/Claude Code event stream, which keys events on `type`. The agent's real
format keys on **`event`**. Our provisional detector classified the real fixture
as `unknown` and read **zero** events from it — the exact failure this work
exists to prevent, caught because we tested against the real artefact instead of
our own assumption.

The design held under that correction: the fix was confined to the per-format
layer (a discriminator helper and a vocabulary table), and no pipeline, scoring
or rendering code changed. Both discriminators are now read. That is the
concrete evidence that the "one ingestion layer" design pays for itself.

Splitting `checkpoint_created` into separate `intent` and `summary` events also
came out of this: the original format renders them as two sections, so merging
them would have made the two formats normalize *differently* — the precise
divergence the layer exists to prevent.

### Verification

`node --test`, no new dependencies, wired into `pr-impact.yml` before the
graph steps. **15/15 passing**, covering all four required cases plus the
regression lock:

| Case | Test |
| --- | --- |
| Original format | parses as today; prose-independent failure detection; `checkpoint list` treated as a *weak* summary source |
| New format | the agent's real 17-line fixture parses fully, 0 unknown, 0 malformed; `event` **and** `type` discriminators; normalizes identically to the original on equivalent content; mixed-format ranges |
| Unknown events | counted per type, surfaced, never thrown; wholly unknown/empty/`null` input degrades |
| Incomplete input | 1 of 3 → `partial`; truncated-but-complete-count → `partial`; newer schema → read, flagged, not trusted |
| **Regression** | a fully-resolved legacy transcript renders **byte-identical** to a golden captured from the pre-Curveball implementation at `15f2c55`, and scores identically (53) |

The golden file was generated by running the **original** `renderMarkdown`
before any edit, and is committed frozen. Regenerating it from current code
would make the regression test a tautology; `test/fixtures/README.md` records
that deliberately.

Live end-to-end after the change: `index` still reports 1,160 symbols / 2,867
external references, and `analyze --base HEAD~7` now prints
`Intent from checkpoint transcripts: 1/7 commits` followed by the partial-context
demotion — the real partial case, reported honestly.

## Checkpoint links and what each checkpoint proves

| Checkpoint | Commit | What it proves |
| --- | --- | --- |
| `f7f01f0c1f5b` | `db337bd` | **Initial understanding.** Reading the checkpoint back reconstructs the architecture — the `relation_scope: external` join, module-path over leaf-name matching, publish-on-merge — without re-reading the source. It also records a real defect found *while* establishing that understanding: a bare `bin/` in `.gitignore` had silently untracked the 554-line CLI entrypoint, so `git status` looked clean while both the workflow and the documented repro invoked a file a fresh clone would not have. |
| `0874724419f8` | `deae614` | **Pre-noon stable.** Repo verified runnable by execution, not syntax-checking: index counts matching the documented table, `analyze` exit 0, `--no-remote` degraded path exercised. Records intent, completed/unresolved work and three named technical risks. It also corrects a stale claim — BUILDATHON.md still said checkpoint capture was inactive — which is the checkpoint trail catching the *document* drifting from reality. |
| _this commit_ | Curveball | **Adaptation under a format change.** The reconstruction above was performed from checkpoint context *before* reading any code, and the graph impact analysis was run *before* editing — enumerating `analyze`, `renderMarkdown` and `renderText` as intent consumers and refuting `scoreFinding`, which does not exist (scoring is inline at `pr-impact.mjs:408-412`). |

**What the trail demonstrates.** Each checkpoint's transcript carries the
*reasoning*, not just the diff — why module-path matching replaced leaf-name
matching, why the index publishes on merge and never on a PR, why line 59
versus 60 was documented instead of smoothed over. A fresh session reconstructed
the product and its open risks from `explain` output alone.

It also demonstrates the limit we then fixed. The pre-noon checkpoint named
substring-based intent matching and merge-time index freshness as risks, but it
did **not** name the format-stability assumption — which is what the Curveball
broke. A checkpoint records the risks you knew about; it does not surface the
assumption you never questioned. That is an honest argument for *reading* the
trail critically rather than trusting it as complete — the same discipline this
change now enforces in the tool itself.

## Setup, run and test instructions

```bash
# Prerequisites
entire plugin install graph
entire graph version          # v0.4.0

# 0. Unit tests (no dependencies; Node's built-in runner)
node --test "ci/pr-impact/test/**/*.test.mjs"

# 1. Index each service repo (writes local shards)
node ci/pr-impact/bin/pr-impact.mjs index --repo ../service-a
node ci/pr-impact/bin/pr-impact.mjs index --repo ../service-b

# 2. Analyze a change in one of them
node ci/pr-impact/bin/pr-impact.mjs analyze \
  --repo ../service-a --base HEAD~25 --format markdown

# 3. With the shared Databricks index instead of local shards
export DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
export DATABRICKS_TOKEN=<token>
export DATABRICKS_WAREHOUSE_ID=<warehouse id>
node ci/pr-impact/bin/pr-impact.mjs index --repo ../service-a --push
node ci/pr-impact/bin/pr-impact.mjs analyze --repo ../service-a --base HEAD~25
```

Reproduction of the documented finding:

```bash
git clone --depth 60 https://github.com/entireio/auth-go demo-auth
git clone --depth 200 https://github.com/entireio/cli   demo-cli
node ci/pr-impact/bin/pr-impact.mjs index --repo demo-cli  --index-dir .pr-index
node ci/pr-impact/bin/pr-impact.mjs index --repo demo-auth --index-dir .pr-index
node ci/pr-impact/bin/pr-impact.mjs analyze --repo demo-auth --base HEAD~25 \
  --index-dir .pr-index --format markdown --no-remote
```

For CI, copy `ci/pr-impact/pr-impact.yml` into `.github/workflows/` and set
the three `DATABRICKS_*` repository secrets.

### Degraded modes

| Condition | Behavior |
| --- | --- |
| Warehouse unreachable / quota exhausted | Warns on stderr, falls back to local index shards, check still runs |
| No checkpoint context (`completeness: unavailable`) | Reports structural cross-repo findings; suppresses the intent comparison rather than marking every consumer unmentioned |
| Some transcripts unreadable (`completeness: partial`) | States the shortfall, demotes "never mentioned" to "not found in the N of M readable transcripts", and suppresses its contribution to the risk score |
| Transcript in an unrecognised format | Counted as unresolved, which lowers completeness; never parsed on a guess |
| Unknown lifecycle/event types | Counted and surfaced in the report; contribute no intent text; never fatal |
| Consumer target has no module path (channel, bare import) | Skipped — cannot be attributed to a repo without guessing |
| Graph plugin missing | Fails loudly; there is no useful degraded mode without it |

## Databricks use, data sources and limitations

**Status: working and verified end-to-end.**

```
workspace.pr_impact.service_surface
  gh/entireio/cli       16,075 rows
  gh/entireio/auth-go      217 rows
```

The decisive test: delete the `cli` shard from the local index so the only
possible source of consumer rows is the warehouse, then re-run. The report is
**identical** to the local-index run — all five `ParseClaims` call sites, same
package attribution — with the header confirming `388 Databricks row(s)`
matched. The warehouse is a verified drop-in for local shards, which is what
makes the CI story real: the runner never clones `cli` at all.

Running the remote path first surfaced two defects the local path did not
have, both now fixed: the warehouse query filters on symbol name only (SQL
cannot evaluate module ownership without the changed symbol's path per row),
so the module and package filters had to be re-applied to remote rows or the
warehouse silently reported matches the local index correctly rejected; and
deduplication keyed on file rather than file+line, which collapsed two calls
in one file into one and lost `contexts.go:173` and `login.go:512`.

**Capability used:** Delta table on the Lakehouse
(`workspace.pr_impact.service_surface`), written and queried through the
**SQL Statement Execution API** (`/api/2.0/sql/statements`) on a serverless
SQL warehouse. REST rather than the CLI/SDK so CI needs no extra install.

**Why it is essential rather than decorative:** the analysis is a join across
*N* repositories, but a PR check runs on one runner with one repo checked out.
Cloning and graph-indexing every other service per pull request is not viable
— `entireio/cli` alone takes ~35s to index. The cross-repo surface must be
written once per repo per merge and queried in milliseconds by every PR in the
estate. That is a shared-analytics workload, and it is the only component here
that cannot be done locally.

**Data provenance:** every row is derived from public source code of the
analyzed repositories via `entire graph symbols` / `entire graph edges`. No
customer data, no secrets, no synthetic rows. Credentials are supplied through
environment variables and CI secrets, and `.env` is gitignored.

**Free Edition constraints designed around:** one serverless 2X-Small
warehouse that may be cold — `wait_timeout: 50s` with `on_wait_timeout:
CANCEL`; inserts batched at 500 tuples to stay within payload limits while
avoiding thousands of round trips; a quota-exhausted warehouse degrades to
local shards instead of failing the check.

## Known limitations and next steps

- **Protocol contracts are invisible.** Services coupled by HTTP routes, gRPC
  or a subprocess JSON protocol (as `external-agents` is to `cli`) produce no
  module-level edge. The graph does emit `HANDLES_ROUTE`, `HTTP_CALLS` and
  `HANDLES_GRPC`; the code carries a `BOUNDARY_TYPES` set and scores those
  higher, but route-string matching across repos is **not yet implemented**.
  This is the most valuable next step and the largest gap between the current
  build and the microservice claim in full generality.
- **Citations point at the enclosing function**, not the exact call line
  (verified: reported 59, actual call 60).
- **Go-centric.** Module identity comes from `go.mod`. Other ecosystems need
  their own manifest readers (`package.json`, `pyproject.toml`).
- **Intent matching is substring-based** on repo names, so it biases toward
  false negatives — a missed warning rather than a false alarm, which is the
  wrong direction for a safety tool. Since the Curveball this is at least
  *bounded*: a partial read can no longer assert absence, so the failure mode
  is an unscored observation rather than a fabricated finding.
- **`completeness` is per-run, not per-repo.** One unreadable transcript
  demotes the whole run to `partial`, including consumers whose evidence was
  complete. That is deliberately conservative — it under-claims rather than
  over-claims — but a per-finding completeness model would recover real signal.
- **`--top` truncation** means a low-reach export with a subtle break can be
  missed.
- **Index freshness is merge-time.** A consumer that added a call since its
  last merge is not yet in the index.
- **The loop stops at reporting.** The check posts a ranked comment and always
  exits 0. It does not gate the merge, does not tell the downstream repo it is
  about to break, and does not confirm the consumer actually fails — only that
  a contract-breaking change reaches it. Today a human has to read the comment
  and decide. See below.

### Next step 1 — close the agentic loop

The highest-value remaining work is turning the report into a workflow, which
is what Track 3 asks for. Detection is done; the loop needs the other three
phases:

```
  DETECT   changed export reaches consumers in other repos      [done]
     ↓
  VERIFY   open each cited file:line and confirm the call is real
           (citations resolve to the enclosing function, and weak-pattern
           matches exist, so acting on an unverified finding would block
           merges on false positives)
     ↓
  DECIDE   gate only where both products agree: contract-breaking AND
           unmentioned in checkpoint intent
     ↓
  ACT      exit non-zero, and open an issue on each consumer repo citing the
           breaking symbol and their exact call sites
```

The decision rule is the point. Blocking on "reaches 5 callers" is noise —
that is ordinary coupling. Blocking on **"reaches 5 callers in another repo
and the author's own recorded reasoning never mentions them"** is a signal
worth stopping a merge for, and it is only expressible because the Graph
supplies the reach and Checkpoints supply the intent. Neither product alone
justifies the action.

Verification must sit *before* the gate, not after: an unverified graph result
is evidence, not fact, and gating on it would make the tool untrustworthy the
first time it blocked a merge wrongly. The same discipline that produced the
line-59-versus-60 finding above is what makes automated action defensible.

Shape: a `pr-impact act` subcommand plus a `SKILL.md` so a coding agent drives
verify → decide → act rather than a human reading a table.

**Further steps in priority order:** route/protocol matching via
`HANDLES_ROUTE` ↔ `HTTP_CALLS`; exact call-site lines; manifest readers for
npm and Python; symbol-aware intent extraction to replace substring matching.
