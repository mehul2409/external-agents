# Fallback evidence — captured 2026-09-06 11:34 IST

Recorded so the demo survives a Databricks Free Edition quota outage.

## Warehouse-only run (local `cli` shard removed)

```
$ node ci/pr-impact/bin/pr-impact.mjs analyze --repo demo-auth --base HEAD~25 --format markdown
```

## Cross-repo impact

`HEAD~25..HEAD` - 348 changed export(s) checked against 1 indexed repo(s) and 388 Databricks row(s).

> Intent from checkpoint transcripts: 3/81 commits.

### `ParseClaims` - risk 38 (contract-breaking)

`tokens/tokens.go:137` - function, signature_changed

Consumed by **1** other repo(s):

| Repo | Relation | Site |
| --- | --- | --- |
| `gh/entireio/cli` | CALLS | `cmd/entire/cli/auth/contexts.go:59` |
| `gh/entireio/cli` | CALLS | `cmd/entire/cli/auth/contexts.go:173` |
| `gh/entireio/cli` | CALLS | `cmd/entire/cli/auth/env_token.go:64` |
| `gh/entireio/cli` | CALLS | `cmd/entire/cli/login.go:472` |
| `gh/entireio/cli` | CALLS | `cmd/entire/cli/login.go:512` |

### `New` - risk 8

`crossjuris/crossjuris.go:111` - function, added

Consumed by **1** other repo(s):

| Repo | Relation | Site |
| --- | --- | --- |
| `gh/entireio/cli` | CALLS | `internal/coreapi/cross_juris_client.go:42` |

### `New` - risk 8

`tokenmanager/tokenmanager.go:279` - function, body_changed

Consumed by **1** other repo(s):

| Repo | Relation | Site |
| --- | --- | --- |
| `gh/entireio/cli` | CALLS | `cmd/entire/cli/auth/refresh.go:119` |

---

_Cross-repo edges come from `relation_scope: external` targets resolved against each repo's exported surface. Weak-pattern matches are name-based and must be verified at the cited line before acting._

## Warehouse contents at capture time

```sql
SELECT repo_key, count(*) FROM workspace.pr_impact.service_surface GROUP BY repo_key
```

| repo_key | rows |
| --- | --- |
| gh/entireio/cli | 16075 |
| gh/entireio/auth-go | 217 |

Statement state: SUCCEEDED
