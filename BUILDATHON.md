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

_To be completed after 12:00._

## Checkpoint links and what each checkpoint proves

_Checkpoint links to be added as milestones land._

Checkpoint capture is **now active** in this fork. The earlier gap — Claude
Code loads Entire hooks at session start, and the first build session
predated `entire enable` here — is resolved: a fresh session inside the fork
captures normally, and `entire checkpoint list` shows the first checkpoint
attached to `db337bd`. The `analyze` command consumes this same data, and its
header reports intent coverage per run (currently `1/4 commits` over
`HEAD~4..HEAD`), so partial coverage is visible in the output rather than
silently assumed.

## Setup, run and test instructions

```bash
# Prerequisites
entire plugin install graph
entire graph version          # v0.4.0

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
| No checkpoint context | Reports structural cross-repo findings; suppresses the intent comparison rather than marking every consumer unmentioned |
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
  wrong direction for a safety tool.
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
