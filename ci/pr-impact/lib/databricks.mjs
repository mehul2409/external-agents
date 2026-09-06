// Databricks-backed cross-repo index.
//
// Why this is not optional decoration: a PR check runs in one repo's CI, with
// one repo checked out. Resolving "who else consumes this symbol" needs the
// external surface of every OTHER service, and a CI runner can neither clone
// nor graph-index 40 repos per pull request. The index has to live somewhere
// shared, be written once per repo per merge, and be queried in milliseconds
// by every PR in the estate. That is a warehouse workload.
//
// Uses the SQL Statement Execution API over REST, so no Databricks CLI or SDK
// install is required in CI.

const CATALOG = process.env.DATABRICKS_CATALOG ?? "workspace";
const SCHEMA = process.env.DATABRICKS_SCHEMA ?? "pr_impact";
const TABLE = `${CATALOG}.${SCHEMA}.service_surface`;

// Workspace URLs are routinely pasted without a scheme, and the bare host
// answers every API path with a 301 that curl and fetch will not re-issue as
// an authenticated request - which surfaces as a confusing auth failure.
function normalizeHost(host) {
  const trimmed = host.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function sql({ host, token, warehouseId }, statement, parameters = []) {
  const base = normalizeHost(host);
  const res = await fetch(`${base}/api/2.0/sql/statements`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      warehouse_id: warehouseId,
      statement,
      parameters,
      // Free Edition runs a single 2X-Small serverless warehouse that may be
      // asleep; allow for the cold start rather than failing the PR check.
      wait_timeout: "50s",
      on_wait_timeout: "CANCEL",
    }),
  });

  if (!res.ok) {
    throw new Error(`Databricks HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = await res.json();
  const state = body.status?.state;
  if (state === "FAILED" || state === "CANCELED" || state === "CLOSED") {
    throw new Error(`statement ${state}: ${body.status?.error?.message ?? "no detail"}`);
  }
  return body;
}

function rowsOf(body) {
  return body.result?.data_array ?? [];
}

export async function ensureTable(conn) {
  await sql(conn, `CREATE SCHEMA IF NOT EXISTS ${CATALOG}.${SCHEMA}`);
  // Delta, keyed by (repo, target path, site) so a re-index of one repo can
  // replace only its own rows.
  await sql(conn, `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      repo_key        STRING,
      module_paths    STRING,
      direction       STRING,
      target          STRING,
      target_path     STRING,
      relation_type   STRING,
      file            STRING,
      line            INT,
      confidence      DOUBLE,
      indexed_at      TIMESTAMP
    ) USING DELTA
  `);
}

// Escape for a SQL string literal. Symbol names and paths come from parsed
// source, so they are not attacker-controlled in the usual sense, but a
// module path with a quote in it should still not break the statement.
function lit(v) {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function publish({ host, token, warehouseId, surface }) {
  const conn = { host, token, warehouseId };
  await ensureTable(conn);

  // Replace this repo's rows rather than appending, so a re-index after a
  // merge does not leave stale contracts behind.
  await sql(conn, `DELETE FROM ${TABLE} WHERE repo_key = ${lit(surface.repoKey)}`);

  const modules = (surface.modulePaths ?? []).join(",");
  const rows = (surface.consumes ?? [])
    .filter((c) => c.qualified)
    .map((c) => `(${[
      lit(surface.repoKey), lit(modules), lit("consumes"), lit(c.target),
      lit(c.path), lit(c.type), lit(c.file),
      c.line == null ? "NULL" : Number(c.line),
      c.confidence == null ? "NULL" : Number(c.confidence),
      "current_timestamp()",
    ].join(", ")})`);

  if (!rows.length) return { ok: true, rows: 0 };

  // Batch: one INSERT per statement would be thousands of round trips, and a
  // single statement with thousands of tuples exceeds the payload limit.
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await sql(conn, `INSERT INTO ${TABLE} VALUES ${chunk.join(", ")}`);
    written += chunk.length;
  }
  return { ok: true, rows: written };
}

export async function consumersOf({ host, token, warehouseId, names }) {
  const conn = { host, token, warehouseId };
  // Deduplicate and bound: a large diff can change hundreds of exports, and
  // the IN list is the query's cost driver.
  const unique = [...new Set(names.filter(Boolean))].slice(0, 400);
  if (!unique.length) return [];

  const body = await sql(conn, `
    SELECT repo_key, target, target_path, relation_type, file, line, confidence
    FROM ${TABLE}
    WHERE direction = 'consumes'
      AND target IN (${unique.map(lit).join(", ")})
  `);

  return rowsOf(body).map((r) => ({
    repo_key: r[0],
    target: r[1],
    target_path: r[2],
    relation_type: r[3],
    file: r[4],
    line: r[5] == null ? null : Number(r[5]),
    confidence: r[6] == null ? null : Number(r[6]),
  }));
}
