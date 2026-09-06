// Gate coverage: verify -> decide -> act.
//
// The decision rule is narrow on purpose, so the tests that matter most are
// the ones proving it REFUSES to fire: on a partial transcript read, and on
// an unverified citation. A gate that blocks merges wrongly is worse than no
// gate at all.
//
//   node --test ci/pr-impact/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { verifyFinding, decide, renderDecision } from "../lib/gate.mjs";
import { issueFor, notifyConsumers } from "../lib/notify.mjs";

// A repo on disk whose cited line really does contain the symbol.
function repoWith(file, line, symbol) {
  const root = mkdtempSync(join(tmpdir(), "pr-impact-gate-"));
  const full = join(root, file);
  mkdirSync(dirname(full), { recursive: true });
  const lines = new Array(line - 1).fill("// filler");
  lines.push(`func ${symbol}(x string) error {`);
  lines.push("  return nil");
  lines.push("}");
  writeFileSync(full, lines.join("\n"));
  return root;
}

function finding(over = {}) {
  return {
    symbol: "ParseClaims",
    kind: "function",
    changeType: "signature_changed",
    breaking: true,
    file: "tokens/tokens.go",
    line: 10,
    consumers: [
      { repoKey: "gh/entireio/cli", file: "auth/contexts.go", line: 10, type: "CALLS" },
    ],
    consumerRepos: ["gh/entireio/cli"],
    unmentionedRepos: ["gh/entireio/cli"],
    unacknowledgedRepos: [],
    ...over,
  };
}

const COMPLETE = { completeness: "complete", canAssertAbsence: true, resolved: 25, total: 25 };
const PARTIAL = { completeness: "partial", canAssertAbsence: false, resolved: 3, total: 25 };

// ------------------------------------------------------------ verify

test("verify: confirms the changed symbol against source in this repo", () => {
  const root = repoWith("tokens/tokens.go", 10, "ParseClaims");
  const v = verifyFinding(finding(), { repo: root });
  assert.equal(v.localConfirmed, true);
  assert.equal(v.verified, true);
});

test("verify: refutes a citation whose symbol is not near the cited line", () => {
  const root = repoWith("tokens/tokens.go", 10, "SomethingElse");
  const v = verifyFinding(finding(), { repo: root });
  assert.equal(v.localConfirmed, false);
  assert.equal(v.verified, false);
});

test("verify: tolerates the enclosing-function offset in graph citations", () => {
  // The graph cites the enclosing function, not the exact call line, so a
  // citation two lines above the symbol must still confirm.
  const root = repoWith("tokens/tokens.go", 12, "ParseClaims");
  const v = verifyFinding(finding({ line: 10 }), { repo: root });
  assert.equal(v.localConfirmed, true);
});

test("verify: consumer citations are 'unavailable', not 'refuted', with no checkout", () => {
  const root = repoWith("tokens/tokens.go", 10, "ParseClaims");
  const v = verifyFinding(finding(), { repo: root });
  const consumer = v.checks.find((c) => c.side === "consumer");
  assert.equal(consumer.status, "unavailable");
  // Not being able to look is not evidence of a problem.
  assert.equal(v.refuted, false);
  assert.equal(v.verified, true);
});

test("verify: confirms consumer citations when a checkout is supplied", () => {
  const root = repoWith("tokens/tokens.go", 10, "ParseClaims");
  const consumerRoot = repoWith("auth/contexts.go", 10, "ParseClaims");
  const v = verifyFinding(finding(), {
    repo: root,
    consumerCheckouts: { "gh/entireio/cli": consumerRoot },
  });
  assert.equal(v.consumersChecked, 1);
  assert.equal(v.consumersConfirmed, 1);
});

// ------------------------------------------------------------ decide

test("verify: a symbol that only appears as part of a longer identifier "
  + "is refuted, not confirmed", () => {
  // Regression. A bare substring test confirmed citations for symbols that do
  // not exist - `notif` "matched" `notifyConsumers`. Verification exists to
  // stop the gate blocking a merge on a false positive, so it must not be a
  // source of false confirmations itself.
  const bogus = {
    symbol: "notif",
    file: "ci/pr-impact/lib/notify.mjs", line: 48, consumers: [],
  };
  const v = verifyFinding(bogus, { repo: process.cwd() });
  assert.equal(v.checks[0].status, "refuted");
  assert.equal(v.verified, false, "an unverified citation cannot gate a merge");

  const real = {
    symbol: "notifyConsumers",
    file: "ci/pr-impact/lib/notify.mjs", line: 48, consumers: [],
  };
  assert.equal(verifyFinding(real, { repo: process.cwd() }).checks[0].status,
    "confirmed", "the real symbol still verifies");
});

test("decide: blocks a verified, contract-breaking, unmentioned finding", () => {
  const root = repoWith("tokens/tokens.go", 10, "ParseClaims");
  const f = finding();
  f.verification = verifyFinding(f, { repo: root });
  const d = decide({ findings: [f], intent: COMPLETE });
  assert.equal(d.action, "block");
  assert.equal(d.exitCode, 1);
  assert.equal(d.blocking.length, 1);
});

test("decide: NEVER blocks on a partial transcript read", () => {
  // The Curveball constraint applied to an action rather than a report: with
  // 3 of 25 transcripts readable, the 22 unread ones are not evidence that
  // the author ignored a consumer.
  const root = repoWith("tokens/tokens.go", 10, "ParseClaims");
  // On a partial read the analyzer demotes unmentioned -> unacknowledged.
  const f = finding({ unmentionedRepos: [], unacknowledgedRepos: ["gh/entireio/cli"] });
  f.verification = verifyFinding(f, { repo: root });
  const d = decide({ findings: [f], intent: PARTIAL });
  assert.equal(d.action, "allow");
  assert.equal(d.exitCode, 0);
  assert.match(d.reasons.join(" "), /absence of a mention is not evidence/);
});

test("decide: downgrades to a warning when the citation could not be verified", () => {
  const root = repoWith("tokens/tokens.go", 10, "SomethingElse");
  const f = finding();
  f.verification = verifyFinding(f, { repo: root });
  const d = decide({ findings: [f], intent: COMPLETE });
  assert.equal(d.action, "allow");
  assert.match(d.reasons.join(" "), /citation not verified - warning only/);
});

test("decide: a non-breaking change never gates, however far it reaches", () => {
  const root = repoWith("tokens/tokens.go", 10, "ParseClaims");
  const f = finding({ breaking: false, changeType: "body_changed" });
  f.verification = verifyFinding(f, { repo: root });
  const d = decide({ findings: [f], intent: COMPLETE });
  assert.equal(d.action, "allow");
});

test("decide: --no-verify still blocks, for estates that accept the risk", () => {
  const root = repoWith("tokens/tokens.go", 10, "SomethingElse");
  const f = finding();
  f.verification = verifyFinding(f, { repo: root });
  const d = decide({ findings: [f], intent: COMPLETE }, { requireVerified: false });
  assert.equal(d.action, "block");
});

// ------------------------------------------------------------ render + act

test("renderDecision: states why the gate did not fire", () => {
  const f = finding({ unmentionedRepos: [], unacknowledgedRepos: ["gh/entireio/cli"] });
  f.verification = { localConfirmed: true, consumersChecked: 0, consumersConfirmed: 0, checks: [] };
  const d = decide({ findings: [f], intent: PARTIAL });
  const out = renderDecision({ findings: [f], intent: PARTIAL }, d);
  assert.match(out, /\*\*ALLOW\*\*/);
  assert.match(out, /Verification against source/);
});

test("notify: builds an issue citing every call site in that repo", () => {
  const issue = issueFor(finding(), "gh/entireio/cli");
  assert.match(issue.title, /ParseClaims/);
  assert.match(issue.body, /auth\/contexts\.go:10/);
  // The receiving maintainer must be told the citation needs confirming.
  assert.match(issue.body, /confirm against source/);
});

test("notify: dry run is the default and creates nothing", async () => {
  const res = await notifyConsumers([finding()], { dryRun: true });
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0].dryRun, true);
  assert.match(res.log.join(" "), /dry-run/);
});
