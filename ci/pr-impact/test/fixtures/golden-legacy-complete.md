## Cross-repo impact

`HEAD~25..HEAD` - 3 changed export(s) checked against 2 indexed repo(s) and 388 Databricks row(s).

> Intent from checkpoint transcripts: 4/4 commits.

### `ParseClaims` - risk 53 (contract-breaking)

`tokens/tokens.go:137` - function, signature_changed

Consumed by **1** other repo(s):

| Repo | Relation | Site |
| --- | --- | --- |
| `gh/entireio/cli` | CALLS | `auth/contexts.go:59` |
| `gh/entireio/cli` | CALLS | `auth/contexts.go:173` |
| `gh/entireio/cli` | CALLS | `auth/env_token.go:64` |
| `gh/entireio/cli` | CALLS | `login.go:472` |
| `gh/entireio/cli` | CALLS | `login.go:512` |

⚠️ Never mentioned in checkpoint intent: `gh/entireio/cli`

---

_Cross-repo edges come from `relation_scope: external` targets resolved against each repo's exported surface. Weak-pattern matches are name-based and must be verified at the cited line before acting._