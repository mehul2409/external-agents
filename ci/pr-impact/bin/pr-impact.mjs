#!/usr/bin/env node
// pr-impact: cross-repo change-risk for microservice codebases.
//
// entire graph impact answers "what breaks in THIS repo". In a microservice
// estate the thing you break lives in someone else's repo, behind an HTTP
// call or a shared contract, and a per-repo graph cannot see it.
//
// The seam is already in the data model: relations that leave a repo are
// emitted with relation_scope "external" and an unresolved `external:...`
// target. This tool indexes what each repo PROVIDES and what each repo
// CONSUMES externally, then resolves one against the other across repos.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalize, canAssertAbsence } from "../lib/transcript.mjs";

const execFileAsync = promisify(execFile);

const USAGE = `pr-impact - cross-repo change impact for microservices

  index    --repo <path> [--index-dir <dir>] [--push]
           Publish this repo's provided + externally-consumed surface.

  analyze  --repo <path> --base <rev> [--head <rev>] [--index-dir <dir>]
           Report which OTHER repos a change in this one reaches.
           [--format text|markdown|json] [--top <n>]

  act      --repo <path> --base <rev> [analyze options]
           Verify each finding against source, decide, and exit non-zero when
           a contract-breaking change reaches another repo that a COMPLETE
           reading of checkpoint intent never mentions.
           [--consumer-checkout <repo_key>=<path>] [--warn-only] [--notify]

Options:
  --index-dir <dir>   Local index location (default: .pr-impact-index)
  --push              Also publish the surface to Databricks
  --no-remote         Never query Databricks; use the local index only

act options:
  --consumer-checkout <repo_key>=<path>
                      Supply a consumer checkout so its cited call sites can
                      be opened and verified. Repeatable.
  --warn-only         Report the decision but always exit 0
  --no-verify         Skip source verification before deciding (not advised:
                      the gate then acts on unverified graph citations)
  --notify            Open an issue on each blocked consumer repo
  --no-dry-run        Actually create those issues (default is a dry run,
                      because this writes to repositories you do not own)
`;

const DEFAULT_INDEX_DIR = ".pr-impact-index";

// Public/exported symbols are the only ones another repo can depend on.
// Go exports by capitalisation; for other languages we keep everything that
// is not obviously private, and let the consumer side do the filtering.
const PRIVATE_PREFIX = /^[_a-z]/;

const CODE_LANGUAGES = new Set([
  "Go", "TypeScript", "JavaScript", "Python", "Java", "Rust",
  "Ruby", "C", "C++", "C#", "Kotlin", "Swift", "PHP", "Scala",
]);

const EXPANDABLE_KINDS = new Set([
  "function", "method", "type", "struct", "interface", "class", "const",
]);

// Relation types that cross a service boundary rather than a package one.
// A CALLS edge marked external is a build-time contract; HTTP_CALLS and the
// route/queue families are runtime contracts between services.
const BOUNDARY_TYPES = new Set([
  "HTTP_CALLS", "HANDLES_ROUTE", "HANDLES_GRPC", "HANDLES_GRAPHQL",
  "HANDLES_TRPC", "LISTENS_ON", "EMITS", "RESOURCE_DEPENDS_ON",
]);

function parseArgs(argv) {
  const opts = {
    repo: ".", head: "HEAD", indexDir: DEFAULT_INDEX_DIR,
    format: "text", top: 8, push: false, remote: true,
    consumerCheckouts: {}, warnOnly: false, noVerify: false,
    notify: false, dryRun: true,
  };
  opts.command = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--base") opts.base = argv[++i];
    else if (a === "--head") opts.head = argv[++i];
    else if (a === "--index-dir") opts.indexDir = argv[++i];
    else if (a === "--format") opts.format = argv[++i];
    else if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "--push") opts.push = true;
    else if (a === "--no-remote") opts.remote = false;
    // Lets the gate verify consumer citations that CI would otherwise be
    // unable to open: --consumer-checkout gh/owner/repo=/path
    else if (a === "--consumer-checkout") {
      const [key, path] = (argv[++i] ?? "").split("=");
      if (!key || !path) throw new Error("--consumer-checkout expects <repo_key>=<path>");
      opts.consumerCheckouts[key] = path;
    }
    else if (a === "--warn-only") opts.warnOnly = true;
    else if (a === "--no-verify") opts.noVerify = true;
    else if (a === "--notify") opts.notify = true;
    // Notification writes to OTHER people's repositories, so it stays a
    // dry run until explicitly told otherwise.
    else if (a === "--no-dry-run") opts.dryRun = false;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

function run(cmd, args, { allowFail = false, cwd } = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8", maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    });
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`${cmd} ${args.join(" ")}: ${(err.stderr || err.message).toString().trim()}`);
  }
}

// Line-delimited JSON from the graph CLI. Malformed lines and unexpected
// schema versions used to vanish silently, so a schema shift would look like
// a smaller graph rather than an unreadable one. Both are now counted and
// reported on stderr - the run still proceeds, because a partial graph is
// more useful than no check, but it no longer passes unnoticed.
const NDJSON_SCHEMA_MAJOR = 1;

function* ndjson(text, stats = {}) {
  stats.malformed ??= 0;
  stats.schemas ??= new Set();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith("{")) { stats.malformed++; continue; }
    let rec;
    try { rec = JSON.parse(t); }
    catch { stats.malformed++; continue; }
    const declared = rec.schema_version ?? rec.schemaVersion;
    if (declared !== undefined && declared !== null) stats.schemas.add(String(declared));
    yield rec;
  }
}

function reportNdjson(label, stats) {
  if (stats.malformed) {
    process.stderr.write(
      `pr-impact: ${label}: skipped ${stats.malformed} unparseable line(s)\n`);
  }
  for (const v of stats.schemas ?? []) {
    if (Number.parseInt(v, 10) > NDJSON_SCHEMA_MAJOR) {
      process.stderr.write(
        `pr-impact: ${label}: schema_version ${v} is newer than this build ` +
        `understands (${NDJSON_SCHEMA_MAJOR}); fields may be missing\n`);
    }
  }
}

// External targets carry their full module path, which is what makes precise
// cross-repo matching possible:
//   external:symbol:github.com/entireio/cli/internal/x.Foo -> path + leaf Foo
//   external:import:os                                     -> stdlib, no path
//   external:channel:error                                 -> runtime channel
//
// Matching on the leaf alone is what produces nonsense: `MkdirAll`, `Marshal`
// and `Errorf` are Go stdlib, but a repo that happens to define a symbol of
// the same name would "own" every consumer of them. The module path is the
// discriminator, and stdlib falls out for free because `os` and `fmt` prefix
// no indexed module.
function externalTarget(toId) {
  if (!toId?.startsWith("external:")) return null;
  const [, ns, ...rest] = toId.split(":");
  const path = rest.join(":");
  if (!path) return null;
  const leaf = path.split(/[./]/).pop();
  return { ns, path, leaf: leaf || null, qualified: path.includes("/") };
}

// A repo owns the module paths declared by its go.mod files, plus the path
// implied by its repo_key (gh/owner/name -> github.com/owner/name).
function moduleePathsFor(repoRoot, repoKey) {
  const paths = new Set();
  const m = repoKey?.match(/^gh\/(.+)$/);
  if (m) paths.add(`github.com/${m[1]}`);

  const found = run("find", [
    repoRoot, "-name", "go.mod", "-not", "-path", "*/vendor/*", "-maxdepth", "4",
  ], { allowFail: true });

  for (const file of (found ?? "").split("\n").filter(Boolean)) {
    try {
      const first = readFileSync(file, "utf8").split("\n")
        .find((l) => l.startsWith("module "));
      if (first) paths.add(first.slice(7).trim());
    } catch { /* unreadable go.mod */ }
  }
  return [...paths];
}

// ------------------------------------------------------------------ index
function buildSurface(opts) {
  const symbolText = run("entire", [
    "graph", "symbols", "--repo", opts.repo, "--format", "ndjson",
  ]);

  let repoKey = null;
  const provides = [];
  const symbolStats = {};
  for (const rec of ndjson(symbolText, symbolStats)) {
    if (rec.repo_key && !repoKey) repoKey = rec.repo_key;
    if (rec.record_type !== "symbol") continue;
    if (!CODE_LANGUAGES.has(rec.language)) continue;
    if (!EXPANDABLE_KINDS.has(rec.kind)) continue;
    if (PRIVATE_PREFIX.test(rec.name ?? "")) continue;
    provides.push({
      name: rec.name,
      qualified: rec.qualified_name ?? rec.name,
      kind: rec.kind,
      file: rec.file_path,
      line: rec.start_line,
      language: rec.language,
    });
  }

  const edgeText = run("entire", [
    "graph", "edges", "--repo", opts.repo, "--format", "ndjson",
  ]);

  reportNdjson("graph symbols", symbolStats);

  const consumes = [];
  const seen = new Set();
  const edgeStats = {};
  for (const rec of ndjson(edgeText, edgeStats)) {
    if (rec.record_type !== "relation") continue;
    if (rec.relation_scope !== "external") continue;

    const target = externalTarget(rec.to_id);
    if (!target) continue;

    const ev = (rec.evidence ?? [])[0] ?? {};
    const key = `${target.path}:${ev.file_path}:${ev.start_line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    consumes.push({
      target: target.leaf,
      path: target.path,
      qualified: target.qualified,
      rawTarget: rec.to_id,
      type: rec.type,
      // Runtime service boundaries matter more than package-level unresolved
      // references; keep the distinction rather than flattening it.
      boundary: BOUNDARY_TYPES.has(rec.type),
      confidence: rec.confidence ?? null,
      weak: (rec.warning_codes ?? []).includes("WEAK_PATTERN"),
      from: rec.from_id?.split(":").pop() ?? null,
      file: ev.file_path ?? null,
      line: ev.start_line ?? null,
    });
  }

  reportNdjson("graph edges", edgeStats);

  return {
    repoKey: repoKey ?? opts.repo,
    modulePaths: moduleePathsFor(opts.repo, repoKey),
    generatedAt: new Date().toISOString(),
    provides,
    consumes,
  };
}

// The graph stamps every record with a stable repo_key; read it from the
// cheapest record rather than re-indexing the whole tree.
function repoKeyOf(repoPath) {
  const out = run("entire", [
    "graph", "symbols", "--repo", repoPath, "--format", "ndjson",
    "--profile", "syntax-only",
  ], { allowFail: true });
  for (const rec of ndjson(out ?? "")) {
    if (rec.repo_key) return rec.repo_key;
  }
  return null;
}

function indexPath(opts, repoKey) {
  mkdirSync(opts.indexDir, { recursive: true });
  return join(opts.indexDir, `${repoKey.replace(/[^\w.-]/g, "_")}.json`);
}

function loadIndex(opts) {
  if (!existsSync(opts.indexDir)) return [];
  const out = [];
  for (const f of readdirSync(opts.indexDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(opts.indexDir, f), "utf8")));
    } catch { /* skip unreadable shard */ }
  }
  return out;
}

// A consumer path looks like `<module>/<pkg dir>.<Symbol>`; the changed symbol
// lives at `<pkg dir>/<file>.go`. Require the package segment to agree, so a
// call to authcode.New is not attributed to deviceflow.New.
function packageMatches(consumerPath, sym) {
  const dot = consumerPath.lastIndexOf(".");
  if (dot === -1) return true;           // no package qualifier to check
  const pkgPath = consumerPath.slice(0, dot);
  const consumerPkg = pkgPath.split("/").pop();
  if (!consumerPkg) return true;

  const parts = (sym.file ?? "").split("/");
  // Root-level file: the package segment is the module leaf, which we cannot
  // compare against a directory. Accept rather than silently drop the finding.
  if (parts.length < 2) return true;
  const symbolPkg = parts[parts.length - 2];
  return consumerPkg === symbolPkg;
}

// ---------------------------------------------------------------- analyze
function changedSymbols(opts) {
  const out = run("entire", [
    "graph", "diff", "--base", opts.base, "--head", opts.head,
    "--repo", opts.repo, "--json",
  ]);
  const start = out.indexOf("{");
  const payload = JSON.parse(out.slice(start));

  const symbols = [];
  for (const file of payload.files ?? []) {
    if (!CODE_LANGUAGES.has(file.language)) continue;
    for (const change of file.changes ?? []) {
      if (!EXPANDABLE_KINDS.has(change.kind)) continue;
      if (PRIVATE_PREFIX.test(change.name ?? "")) continue;
      symbols.push({
        name: change.name,
        kind: change.kind,
        type: change.type,
        file: file.path,
        line: change.after_start_line ?? change.before_start_line ?? null,
        dependents: change.dependents_count ?? 0,
        // A removed or signature-changed export is contract-breaking for a
        // consumer; a body change usually is not.
        breaking: change.type === "removed" || change.type === "signature_changed",
      });
    }
  }
  return symbols;
}

// Collect one raw document per commit and hand them to the ingestion layer.
//
// This function deliberately knows NOTHING about transcript layout. It used
// to decide readability by matching English prose ("No associated Entire
// checkpoint") and to mine intent out of the human-rendered `checkpoint list`
// table with a layout regex - so an upstream wording or column change would
// silently turn a failure message into scored intent. Format knowledge now
// lives in lib/transcript.mjs and nowhere else.
function checkpointIntent(opts) {
  const log = run("git", ["-C", opts.repo, "log", "--format=%H",
    `${opts.base}..${opts.head}`], { allowFail: true });
  const commits = (log ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!commits.length) return intentResult(normalize([]));

  const documents = commits.slice(0, 25).map((sha) => ({
    commit: sha,
    raw: run("entire", ["checkpoint", "explain", "--commit", sha],
      { allowFail: true, cwd: opts.repo }) ?? "",
  }));

  let intent = intentResult(normalize(documents));

  // Tier 2: nothing resolved per-commit, so fall back to the checkpoint
  // listing. It is a weaker source - one line of summary rather than a
  // transcript - and normalize() labels it as such, so the report can say
  // "summaries" instead of overstating what was read.
  if (intent.resolved === 0) {
    const listing = run("entire", ["checkpoint", "list"],
      { allowFail: true, cwd: opts.repo }) ?? "";
    const inRange = new Set(commits.map((c) => c.slice(0, 7)));
    const listed = normalize([{ commit: null, raw: listing }]);
    const matched = listed.events.filter(
      (e) => e.commit && inRange.has(e.commit.slice(0, 7)));
    if (matched.length) {
      intent = intentResult({
        ...listed,
        events: matched,
        text: matched.map((e) => e.text).filter(Boolean).join("\n").toLowerCase(),
        resolved: matched.length,
        total: commits.length,
        // Summaries are one line per commit; they are never a complete
        // record of what the author considered.
        completeness: "partial",
        source: "summary",
      });
    }
  }
  return intent;
}

// Adapt the normalized shape to what the rest of the tool consumes.
// `available` is retained so existing consumers and the JSON output keep
// working, but it is now derived from completeness rather than being the
// binary truth it used to be.
function intentResult(n) {
  return {
    available: n.completeness !== "unavailable",
    completeness: n.completeness,
    source: n.source === "none" ? undefined : n.source,
    text: n.text,
    resolved: n.resolved,
    total: n.total,
    unknownEvents: n.unknownEvents,
    unknownEventCount: n.unknownEventCount,
    malformedLines: n.malformedLines,
    formats: n.formats,
    schemaVersions: n.schemaVersions,
    // The single question the scorer and renderers must ask before stating
    // that something is absent from the author's recorded reasoning.
    canAssertAbsence: canAssertAbsence(n),
  };
}

function analyze(opts, shards, remote) {
  const changed = changedSymbols(opts);
  const intent = checkpointIntent(opts);

  // Which module paths does the repo under analysis own? A consumer only
  // counts if its external target resolves into one of them.
  const selfKey = repoKeyOf(opts.repo);
  const selfModules = moduleePathsFor(opts.repo, selfKey);

  const ownsTarget = (path) =>
    selfModules.some((m) => path === m || path.startsWith(`${m}/`) || path.startsWith(`${m}.`));

  const findings = [];
  for (const sym of changed) {
    const consumers = [];

    for (const shard of shards) {
      // A repo consuming its own module is an internal reference the
      // single-repo graph already covers; only cross-repo edges belong here.
      if (shard.repoKey === selfKey) continue;
      for (const c of shard.consumes ?? []) {
        if (c.target !== sym.name) continue;
        // Unqualified targets (channels, bare imports) carry no module path
        // and cannot be attributed to a repo without guessing.
        if (!c.qualified || !ownsTarget(c.path)) continue;
        // Same-module leaf names still collide: auth-go defines `New` in
        // authcode, crossjuris and deviceflow, and matching on the leaf
        // reports all three for a call that can only mean one. The consumer
        // path names the package, so require it to match the changed
        // symbol's own package directory.
        if (!packageMatches(c.path, sym)) continue;
        consumers.push({ ...c, repoKey: shard.repoKey });
      }
    }

    for (const row of remote) {
      if (row.target !== sym.name) continue;
      if (row.repo_key === selfKey) continue;
      // The warehouse query filters by symbol name only - it cannot evaluate
      // module ownership or package agreement in SQL without shipping the
      // changed symbol's file path per row. Apply the same two filters the
      // local path uses, or the remote source silently reports matches the
      // local one correctly rejects.
      if (!row.target_path || !ownsTarget(row.target_path)) continue;
      if (!packageMatches(row.target_path, sym)) continue;
      // Deduplicate on the full site: two calls in one file are two distinct
      // findings, and keying on the file alone drops the second.
      const dup = consumers.some((c) =>
        c.repoKey === row.repo_key && c.file === row.file && c.line === row.line);
      if (dup) continue;
      consumers.push({
        target: row.target, repoKey: row.repo_key, type: row.relation_type,
        boundary: BOUNDARY_TYPES.has(row.relation_type), file: row.file,
        line: row.line, confidence: row.confidence, weak: false, remote: true,
      });
    }

    if (!consumers.length) continue;

    const repos = [...new Set(consumers.map((c) => c.repoKey))];
    // A repo whose name never appears in the intent we read. Whether that
    // is a FINDING or merely a GAP depends entirely on how much we read.
    const absent = intent.completeness === "unavailable"
      ? []
      : repos.filter((r) => !intent.text.includes(r.split("/").pop().toLowerCase()));
    // Only a complete read supports the claim "the author never mentioned
    // this". With 3 of 81 transcripts readable, 78 unread transcripts are
    // not evidence of absence - asserting otherwise manufactures findings
    // out of missing data.
    const unmentioned = intent.canAssertAbsence ? absent : [];
    const unacknowledged = intent.canAssertAbsence ? [] : absent;

    findings.push({
      symbol: sym.name,
      kind: sym.kind,
      changeType: sym.type,
      breaking: sym.breaking,
      file: sym.file,
      line: sym.line,
      localDependents: sym.dependents,
      consumerRepos: repos,
      consumers: consumers.slice(0, 12),
      unmentionedRepos: unmentioned,
      // Reported, but never scored: a demoted observation about what the
      // readable subset happened to contain.
      unacknowledgedRepos: unacknowledged,
      boundaryHits: consumers.filter((c) => c.boundary).length,
      risk: 0,
    });
  }

  for (const f of findings) {
    let score = Math.min(f.consumerRepos.length, 5) / 5 * 40;
    if (f.breaking) score += 30;
    if (f.boundaryHits) score += 15;
    // Suppressed rather than scored when the read was partial: the +15
    // exists to flag a consumer the author demonstrably did not consider,
    // and a transcript we could not read demonstrates nothing.
    if (f.unmentionedRepos.length) score += 15;
    f.risk = Math.round(score);
  }
  findings.sort((a, b) => b.risk - a.risk);

  return {
    repo: opts.repo, base: opts.base, head: opts.head,
    changedExports: changed.length,
    indexedRepos: shards.length,
    remoteRows: remote.length,
    intent, findings: findings.slice(0, opts.top),
  };
}

// ----------------------------------------------------------------- output
function renderMarkdown(r) {
  const out = [];
  out.push("## Cross-repo impact");
  out.push("");
  out.push(
    `\`${r.base}..${r.head}\` - ${r.changedExports} changed export(s) checked ` +
    `against ${r.indexedRepos} indexed repo(s)` +
    (r.remoteRows ? ` and ${r.remoteRows} Databricks row(s).` : "."),
  );

  const c = r.intent.completeness ?? (r.intent.available ? "complete" : "unavailable");
  if (c === "unavailable") {
    out.push("");
    out.push("> No checkpoint context for these commits - intent comparison unavailable.");
  } else {
    out.push("");
    out.push(
      `> Intent from checkpoint ${r.intent.source === "summary" ? "summaries" : "transcripts"}: ` +
      `${r.intent.resolved}/${r.intent.total} commits.`,
    );
    // The count alone was already printed before this change and was still
    // not wired to the claims below. Say plainly what a partial read means.
    if (c === "partial") {
      out.push(
        `> **Partial context.** ${r.intent.total - r.intent.resolved} of ` +
        `${r.intent.total} transcript(s) could not be read, so this run cannot ` +
        `state that a consumer went unmentioned - only that it was not found ` +
        `in the ${r.intent.resolved} that were readable.`,
      );
    }
  }
  if (r.intent.unknownEventCount) {
    out.push(
      `> ${r.intent.unknownEventCount} unrecognised checkpoint event(s) ignored: ` +
      r.intent.unknownEvents.map((u) => `\`${u.type}\` x${u.count}`).join(", ") + ".",
    );
  }
  if (r.intent.malformedLines) {
    out.push(`> ${r.intent.malformedLines} malformed transcript line(s) skipped.`);
  }
  out.push("");

  if (!r.findings.length) {
    out.push("No changed export in this diff is consumed by another indexed repo.");
    return out.join("\n");
  }

  for (const f of r.findings) {
    out.push(`### \`${f.symbol}\` - risk ${f.risk}${f.breaking ? " (contract-breaking)" : ""}`);
    out.push("");
    out.push(`\`${f.file}:${f.line ?? "?"}\` - ${f.kind}, ${f.changeType}`);
    out.push("");
    out.push(`Consumed by **${f.consumerRepos.length}** other repo(s):`);
    out.push("");
    out.push("| Repo | Relation | Site |");
    out.push("| --- | --- | --- |");
    for (const c of f.consumers) {
      const rel = c.boundary ? `**${c.type}**` : c.type;
      out.push(`| \`${c.repoKey}\` | ${rel} | \`${c.file ?? "?"}:${c.line ?? "?"}\` |`);
    }
    out.push("");
    if (f.unmentionedRepos.length) {
      out.push(
        `⚠️ Never mentioned in checkpoint intent: ` +
        f.unmentionedRepos.map((x) => `\`${x}\``).join(", "),
      );
      out.push("");
    }
    // Same observation, demoted to what the evidence actually supports, and
    // not scored. Stated as a fact about our reading, not about the author.
    if (f.unacknowledgedRepos?.length) {
      out.push(
        `ℹ️ Not found in the ${r.intent.resolved} of ${r.intent.total} ` +
        `transcript(s) that were readable: ` +
        f.unacknowledgedRepos.map((x) => `\`${x}\``).join(", ") +
        ` - unread transcripts may mention them, so this is not scored.`,
      );
      out.push("");
    }
  }

  out.push("---");
  out.push("");
  out.push(
    "_Cross-repo edges come from `relation_scope: external` targets resolved " +
    "against each repo's exported surface. Weak-pattern matches are " +
    "name-based and must be verified at the cited line before acting._",
  );
  return out.join("\n");
}

function renderText(r) {
  return renderMarkdown(r)
    .replace(/^#+ /gm, "").replace(/\*\*/g, "").replace(/`/g, "");
}

// -------------------------------------------------------------- databricks
async function databricks(opts, surface) {
  const { DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID } = process.env;
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) {
    return { ok: false, reason: "DATABRICKS_HOST / _TOKEN / _WAREHOUSE_ID not set" };
  }
  const mod = await import("../lib/databricks.mjs");
  return mod.publish({
    host: DATABRICKS_HOST, token: DATABRICKS_TOKEN,
    warehouseId: DATABRICKS_WAREHOUSE_ID, surface,
  });
}

async function queryRemote(opts, names) {
  if (!opts.remote || !names.length) return [];
  const { DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID } = process.env;
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) return [];
  try {
    const mod = await import("../lib/databricks.mjs");
    return await mod.consumersOf({
      host: DATABRICKS_HOST, token: DATABRICKS_TOKEN,
      warehouseId: DATABRICKS_WAREHOUSE_ID, names,
    });
  } catch (err) {
    // A quota-exhausted or unreachable warehouse must degrade to the local
    // index rather than fail the PR check.
    process.stderr.write(`pr-impact: Databricks unavailable (${err.message}); using local index\n`);
    return [];
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { process.stderr.write(`${err.message}\n\n${USAGE}`); process.exit(2); }

  if (opts.help || !opts.command || !["index", "analyze", "act"].includes(opts.command)) {
    process.stdout.write(USAGE);
    process.exit(opts.command ? 0 : 2);
  }

  if (opts.command === "index") {
    const surface = buildSurface(opts);
    const path = indexPath(opts, surface.repoKey);
    writeFileSync(path, JSON.stringify(surface, null, 2));
    process.stdout.write(
      `indexed ${surface.repoKey}: ${surface.provides.length} exported symbol(s), ` +
      `${surface.consumes.length} external reference(s) -> ${path}\n`,
    );
    if (opts.push) {
      const res = await databricks(opts, surface);
      process.stdout.write(res.ok
        ? `pushed ${res.rows} row(s) to Databricks\n`
        : `Databricks push skipped: ${res.reason}\n`);
    }
    return;
  }

  if (!opts.base) {
    process.stderr.write(`${opts.command} requires --base\n`);
    process.exit(2);
  }

  const shards = loadIndex(opts);
  const changed = changedSymbols(opts);
  const remote = await queryRemote(opts, changed.map((c) => c.name));
  const result = analyze(opts, shards, remote);

  if (opts.command === "analyze") {
    if (opts.format === "json") process.stdout.write(JSON.stringify(result, null, 2));
    else if (opts.format === "markdown") process.stdout.write(renderMarkdown(result));
    else process.stdout.write(renderText(result));
    process.stdout.write("\n");
    return;
  }

  // --- act: verify -> decide -> act ----------------------------------------
  const { verifyFinding, decide, renderDecision } = await import("../lib/gate.mjs");

  // VERIFY before DECIDE. Acting on unverified evidence is the failure mode
  // that makes an automated gate untrustworthy.
  for (const f of result.findings) {
    f.verification = verifyFinding(f, {
      repo: opts.repo,
      consumerCheckouts: opts.consumerCheckouts,
    });
  }

  const decision = decide(result, { requireVerified: !opts.noVerify });

  const body = (opts.format === "json")
    ? JSON.stringify({ ...result, decision }, null, 2)
    : renderMarkdown(result) + "\n" + renderDecision(result, decision);
  process.stdout.write(body + "\n");

  if (opts.notify && decision.action === "block") {
    const { notifyConsumers } = await import("../lib/notify.mjs");
    const res = await notifyConsumers(decision.blocking, { dryRun: opts.dryRun });
    for (const line of res.log) process.stderr.write(`${line}\n`);
  }

  // ACT: the exit code is the action. --warn-only keeps the report without
  // failing the check, for estates adopting the gate gradually.
  if (opts.warnOnly) return;
  process.exitCode = decision.exitCode;
}

// Run only when invoked as the CLI, so the test suite can import the real
// renderers and scorer rather than re-implementing them.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`pr-impact: ${err.message}\n`);
    process.exit(1);
  });
}

export { analyze, renderMarkdown, renderText, checkpointIntent, ndjson };
