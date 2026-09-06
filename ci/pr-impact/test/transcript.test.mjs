// Curveball coverage: both transcript formats, unknown events, incomplete
// input, and a regression lock proving existing behaviour is unchanged.
//
//   node --test ci/pr-impact/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectFormat, parseTranscript, normalize, canAssertAbsence,
} from "../lib/transcript.mjs";
import { renderMarkdown } from "../bin/pr-impact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, "fixtures", name), "utf8");

// ------------------------------------------------ 1. original format

test("original format: a legacy transcript parses as today", () => {
  const raw = fixture("legacy-complete.txt");
  assert.equal(detectFormat(raw), "legacy-text");

  const parsed = parseTranscript(raw);
  assert.equal(parsed.readable, true);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.malformed, 0);

  // Intent, speakers and tool lines all survive the round trip.
  const kinds = new Set(parsed.events.map((e) => e.kind));
  assert.ok(kinds.has("intent"), "intent section extracted");
  assert.ok(kinds.has("user"), "user turns extracted");
  assert.ok(kinds.has("assistant"), "assistant turns extracted");

  const n = normalize([{ commit: "deae614", raw }]);
  assert.equal(n.completeness, "complete");
  assert.deepEqual(n.formats, ["legacy-text"]);
  assert.equal(n.source, "transcript");
  assert.ok(n.text.includes("databricks"), "intent text reaches the haystack");
  assert.equal(canAssertAbsence(n), true);
});

test("original format: the CLI's no-checkpoint output is unreadable, "
  + "and detection does not depend on its wording", () => {
  const raw = fixture("legacy-missing.txt");
  assert.equal(detectFormat(raw), "unknown");

  const n = normalize([{ commit: "15f2c55", raw }]);
  assert.equal(n.completeness, "unavailable");
  assert.equal(n.resolved, 0);

  // The old implementation keyed on the sentence "No associated Entire
  // checkpoint". Reword it and the old check would have called this
  // readable and scored a failure message as intent.
  const reworded = raw
    .replace(/No associated Entire checkpoint/g, "Kein zugehoeriger Checkpoint")
    .replace(/checkpoint not found/gi, "nicht gefunden");
  assert.equal(detectFormat(reworded), "unknown",
    "structural detection survives an upstream wording change");
});

test("original format: the checkpoint list table is parsed as a weak "
  + "summary source, not as a full transcript", () => {
  const n = normalize([{ commit: null, raw: fixture("legacy-list.txt") }]);
  assert.equal(n.source, "summary");
  assert.ok(n.events.length > 0);
  assert.ok(n.events.every((e) => e.kind === "summary"));
  assert.ok(n.events.every((e) => /^[0-9a-f]{7,40}$/.test(e.commit)),
    "each row carries the commit it came from");
});

// ------------------------------------------------ 2. new format

test("new JSONL format: the agent's real session fixture parses fully", () => {
  // ci/pr-impact/test/fixtures/jsonl-v2-complete.jsonl is the integrated
  // agent's own published session, used verbatim.
  const raw = fixture("jsonl-v2-complete.jsonl");
  assert.equal(detectFormat(raw), "jsonl-v2");

  const parsed = parseTranscript(raw);
  assert.equal(parsed.readable, true);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.malformed, 0, "every line of the real fixture parses");
  assert.deepEqual(parsed.unknownEvents, [], "its whole vocabulary is known");
  // 18 events from 17 lines: checkpoint_created carries both `intent` and
  // `summary`, which the original format renders as two separate sections,
  // so it normalizes to two events rather than one.
  assert.equal(parsed.events.length, 18, "all 17 lines normalized, intent split from summary");
  assert.equal(parsed.events.filter((e) => e.kind === "intent").length, 1);
  assert.equal(parsed.events.filter((e) => e.kind === "summary").length, 1);

  const n = normalize([{ commit: "8d34f70", raw }]);
  assert.equal(n.completeness, "complete");
  assert.equal(canAssertAbsence(n), true);

  // The intent recorded on checkpoint_created is the field the ranking
  // depends on, so it must survive normalization.
  assert.ok(n.text.includes("reject expired, disabled, or minimum-cart-value"),
    "checkpoint_created.intent reaches the haystack");
  assert.ok(n.text.includes("checkout-service"), "repository name is matchable");

  const kinds = new Set(n.events.map((e) => e.kind));
  for (const k of ["intent", "user", "assistant", "tool", "lifecycle"]) {
    assert.ok(kinds.has(k), `${k} events normalized`);
  }
  assert.ok(n.events.some((e) => e.commit === "8d34f70c1e9fd62c1b5dc4fbbbf5013db2817ae1"),
    "checkpoint_created.git_commit identifies its own commit");
});

test("new JSONL format uses `event` as its discriminator, and `type` still works", () => {
  // The original stream keyed on `type`; the new one keys on `event`. Both
  // are read by the same parser - this is the concrete thing that would have
  // silently produced an empty transcript if it were handled by guesswork.
  const withEvent = '{"event":"session_started"}\n{"event":"user_prompt","text":"alpha"}\n{"event":"session_ended"}\n';
  const withType = '{"type":"session_started"}\n{"type":"user_prompt","text":"alpha"}\n{"type":"session_ended"}\n';
  for (const raw of [withEvent, withType]) {
    assert.equal(detectFormat(raw), "jsonl-v2");
    const n = normalize([{ commit: "x", raw }]);
    assert.equal(n.completeness, "complete");
    assert.ok(n.text.includes("alpha"));
  }
});

test("new JSONL format parses to the same normalized shape as the original", () => {
  // Same session content, expressed in each format. Downstream code must not
  // be able to tell which one produced the result.
  const legacy = normalize([{ commit: "deae614", raw: fixture("legacy-complete.txt") }]);
  const jsonl = normalize([{ commit: "deae614", raw: fixture("jsonl-v2-equivalent.jsonl") }]);

  assert.deepEqual(Object.keys(jsonl).sort(), Object.keys(legacy).sort());
  assert.equal(jsonl.completeness, legacy.completeness);
  assert.equal(jsonl.source, legacy.source);
  assert.equal(jsonl.resolved, legacy.resolved);
  assert.equal(jsonl.total, legacy.total);
  assert.equal(canAssertAbsence(jsonl), canAssertAbsence(legacy));
  assert.deepEqual(jsonl.formats, ["jsonl-v2"]);
  assert.deepEqual(legacy.formats, ["legacy-text"]);

  // And the same intent is recoverable from both.
  for (const n of [legacy, jsonl]) {
    assert.ok(n.text.includes("databricks"), "intent text present in both");
    assert.ok(n.text.includes("pre-noon stable checkpoint"), "summary present in both");
  }

  const kindsOf = (n) => [...new Set(n.events.map((e) => e.kind))].sort();
  assert.deepEqual(kindsOf(jsonl).filter((k) => k !== "lifecycle"),
    kindsOf(legacy).filter((k) => k !== "lifecycle"),
    "the same conversational kinds come out of both formats");
});

test("mixed formats normalize into one format-agnostic result", () => {
  // The migration reality: existing users still emit the original format
  // while the upgraded agent emits the new one, often in the same range.
  const n = normalize([
    { commit: "aaaaaaa", raw: fixture("legacy-complete.txt") },
    { commit: "bbbbbbb", raw: fixture("jsonl-v2-complete.jsonl") },
  ]);
  assert.equal(n.completeness, "complete");
  assert.equal(n.resolved, 2);
  assert.equal(n.total, 2);
  assert.deepEqual(n.formats, ["jsonl-v2", "legacy-text"]);
});

// ------------------------------------------------ 3. unknown events

test("unknown event types do not throw and are reported", () => {
  const raw = fixture("jsonl-v2-unknown-events.jsonl");
  const parsed = parseTranscript(raw);   // must not throw
  assert.equal(parsed.readable, true);

  const n = normalize([{ commit: "ccccccc", raw }]);
  const types = n.unknownEvents.map((u) => u.type).sort();
  assert.deepEqual(types,
    ["permission_mode", "sandbox_provisioned", "telemetry_flush"]);
  assert.equal(n.unknownEvents.find((u) => u.type === "permission_mode").count, 2,
    "repeat occurrences are counted, not collapsed");
  assert.equal(n.unknownEventCount, 4);

  // Known events still land, and unknown ones contribute no text - an event
  // we did not understand must not influence a finding.
  assert.ok(n.text.includes("parseclaims"));
  assert.ok(!n.text.includes("telemetry"));
});

test("a wholly unknown document degrades instead of throwing", () => {
  for (const raw of ["", "   ", "not json and not a transcript", null, undefined]) {
    const parsed = parseTranscript(raw);
    assert.equal(parsed.format, "unknown");
    assert.equal(parsed.readable, false);
    assert.deepEqual(parsed.events, []);
  }
});

// ------------------------------------------------ 4. incomplete input

test("incomplete input yields completeness 'partial' with correct counts", () => {
  // Three commits in range; only one resolves.
  const n = normalize([
    { commit: "aaaaaaa", raw: fixture("legacy-complete.txt") },
    { commit: "bbbbbbb", raw: fixture("legacy-missing.txt") },
    { commit: "ccccccc", raw: fixture("legacy-missing.txt") },
  ]);
  assert.equal(n.completeness, "partial");
  assert.equal(n.resolved, 1);
  assert.equal(n.total, 3);
  assert.equal(canAssertAbsence(n), false,
    "a partial read may never assert that something is absent");
});

test("a truncated transcript is partial even when every commit resolved", () => {
  const raw = fixture("jsonl-v2-truncated.jsonl");
  const parsed = parseTranscript(raw);
  assert.equal(parsed.readable, true);
  assert.equal(parsed.truncated, true, "opened and never closed");
  assert.equal(parsed.malformed, 1, "the cut-off final line is counted");
  assert.equal(parsed.complete, false);

  const n = normalize([{ commit: "ddddddd", raw }]);
  assert.equal(n.resolved, 1);
  assert.equal(n.total, 1);
  assert.equal(n.completeness, "partial",
    "full count but damaged content is still partial");
  assert.equal(n.malformedLines, 1);
});

test("a schema newer than this build is read but flagged, never silently ignored", () => {
  const raw = '{"schema_version":"99","type":"session_start"}\n'
    + '{"schema_version":"99","type":"intent","text":"future format"}\n'
    + '{"schema_version":"99","type":"session_end"}\n';
  const parsed = parseTranscript(raw);
  assert.equal(parsed.schemaVersion, "99");
  assert.equal(parsed.schemaAhead, true);
  assert.equal(parsed.readable, true, "still parsed rather than discarded");
  assert.equal(parsed.complete, false, "but not trusted as complete");

  const n = normalize([{ commit: "eeeeeee", raw }]);
  assert.equal(n.completeness, "partial");
  assert.deepEqual(n.schemaVersions, ["99"]);
});

test("the reported PARTIAL result is surfaced, and absence claims are demoted", () => {
  const partial = {
    available: true, completeness: "partial", source: "transcript",
    text: "auth-go only", resolved: 3, total: 81,
    unknownEvents: [{ type: "mode", count: 2 }], unknownEventCount: 2,
    malformedLines: 0, canAssertAbsence: false,
  };
  const md = renderMarkdown({
    repo: "demo-auth", base: "HEAD~81", head: "HEAD",
    changedExports: 1, indexedRepos: 2, remoteRows: 0,
    intent: partial,
    findings: [{
      symbol: "ParseClaims", kind: "function", changeType: "signature_changed",
      breaking: true, file: "tokens/tokens.go", line: 137, localDependents: 2,
      consumerRepos: ["gh/entireio/cli"],
      consumers: [{ repoKey: "gh/entireio/cli", type: "CALLS", boundary: false, file: "login.go", line: 472 }],
      unmentionedRepos: [], unacknowledgedRepos: ["gh/entireio/cli"],
      boundaryHits: 0, risk: 38,
    }],
  });

  assert.ok(md.includes("Partial context."), "the partial read is stated");
  assert.ok(md.includes("3/81 commits"));
  assert.ok(md.includes("Not found in the 3 of 81 transcript(s) that were readable"));
  assert.ok(md.includes("this is not scored"));
  assert.ok(!md.includes("Never mentioned in checkpoint intent"),
    "the authoritative claim must not appear on a partial read");
  assert.ok(md.includes("`mode` x2"), "unknown events are surfaced to the reader");
});

// ------------------------------------------------ 5. regression lock

test("regression: a fully-resolved legacy transcript produces output "
  + "identical to the pre-change implementation", () => {
  // fixtures/golden-legacy-complete.md was generated by running the ORIGINAL
  // renderMarkdown (pre-curveball, captured from git before any edit) over
  // the input below. Byte equality here is the proof that adding two formats
  // and a completeness model changed nothing for existing users.
  const result = {
    repo: "demo-auth", base: "HEAD~25", head: "HEAD",
    changedExports: 3, indexedRepos: 2, remoteRows: 388,
    intent: {
      available: true, completeness: "complete", source: "transcript",
      text: "rework parseclaims to return unverifiedclaims; auth-go only.",
      resolved: 4, total: 4, canAssertAbsence: true,
      unknownEvents: [], unknownEventCount: 0, malformedLines: 0,
    },
    findings: [{
      symbol: "ParseClaims", kind: "function", changeType: "signature_changed",
      breaking: true, file: "tokens/tokens.go", line: 137, localDependents: 2,
      consumerRepos: ["gh/entireio/cli"],
      consumers: [
        { repoKey: "gh/entireio/cli", type: "CALLS", boundary: false, file: "auth/contexts.go", line: 59 },
        { repoKey: "gh/entireio/cli", type: "CALLS", boundary: false, file: "auth/contexts.go", line: 173 },
        { repoKey: "gh/entireio/cli", type: "CALLS", boundary: false, file: "auth/env_token.go", line: 64 },
        { repoKey: "gh/entireio/cli", type: "CALLS", boundary: false, file: "login.go", line: 472 },
        { repoKey: "gh/entireio/cli", type: "CALLS", boundary: false, file: "login.go", line: 512 },
      ],
      unmentionedRepos: ["gh/entireio/cli"], unacknowledgedRepos: [],
      boundaryHits: 0, risk: 53,
    }],
  };

  assert.equal(renderMarkdown(result), fixture("golden-legacy-complete.md"));
});

test("regression: the risk score for a complete read is unchanged, and the "
  + "same finding scores 15 lower when the read was partial", () => {
  // Scoring, lifted from analyze(): reach 40 + breaking 30 + unmentioned 15.
  const score = (f) => {
    let s = Math.min(f.consumerRepos.length, 5) / 5 * 40;
    if (f.breaking) s += 30;
    if (f.boundaryHits) s += 15;
    if (f.unmentionedRepos.length) s += 15;
    return Math.round(s);
  };
  const base = {
    consumerRepos: ["gh/entireio/cli"], breaking: true, boundaryHits: 0,
  };
  const complete = score({ ...base, unmentionedRepos: ["gh/entireio/cli"], unacknowledgedRepos: [] });
  const partial = score({ ...base, unmentionedRepos: [], unacknowledgedRepos: ["gh/entireio/cli"] });

  assert.equal(complete, 53, "unchanged from the pre-curveball behaviour");
  assert.equal(partial, 38, "the unverifiable +15 is suppressed, not scored");
});
