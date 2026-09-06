// gate: the verify -> decide -> act half of the loop.
//
// Detection alone leaves a human to read a table and decide. This closes it.
// The ordering is the whole design: VERIFY must run before DECIDE, because
// graph output is evidence rather than fact, and a gate that blocks merges on
// unverified evidence is untrustworthy the first time it is wrong.
//
// What we can and cannot verify differs by side, and the difference is
// reported rather than hidden:
//   - the CHANGED symbol lives in the repo under analysis, so it is readable
//   - the CONSUMER lives in another repo that CI has not checked out, so it
//     is verifiable only when a checkout is supplied

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Graph citations resolve to the enclosing function rather than the exact
// call line, so an exact-line assertion would fail on true positives. Scan a
// window instead.
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 40;

function readWindow(file, line) {
  if (!existsSync(file)) return null;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  if (!line) return text;
  const from = Math.max(0, line - 1 - WINDOW_BEFORE);
  const to = Math.min(lines.length, line + WINDOW_AFTER);
  return lines.slice(from, to).join("\n");
}

// consumerCheckouts: { "gh/entireio/cli": "/path/to/checkout" }
export function verifyFinding(finding, { repo = ".", consumerCheckouts = {} } = {}) {
  const checks = [];

  // --- changed symbol, our side -------------------------------------------
  const localWindow = readWindow(join(repo, finding.file), finding.line);
  const localOk = localWindow != null && localWindow.includes(finding.symbol);
  checks.push({
    side: "changed-symbol",
    target: `${finding.file}:${finding.line ?? "?"}`,
    status: localWindow == null ? "unreadable" : localOk ? "confirmed" : "refuted",
    detail: localWindow == null
      ? "file not readable from this checkout"
      : localOk
        ? `\`${finding.symbol}\` found within the cited window`
        : `\`${finding.symbol}\` NOT found near the cited line`,
  });

  // --- consumers, other repos ---------------------------------------------
  let consumersConfirmed = 0;
  let consumersChecked = 0;
  for (const c of finding.consumers ?? []) {
    const root = consumerCheckouts[c.repoKey];
    if (!root) {
      checks.push({
        side: "consumer",
        target: `${c.repoKey} ${c.file ?? "?"}:${c.line ?? "?"}`,
        status: "unavailable",
        detail: "consumer repo not checked out; cannot open the cited line",
      });
      continue;
    }
    consumersChecked++;
    const w = readWindow(join(root, c.file ?? ""), c.line);
    const ok = w != null && w.includes(finding.symbol);
    if (ok) consumersConfirmed++;
    checks.push({
      side: "consumer",
      target: `${c.repoKey} ${c.file ?? "?"}:${c.line ?? "?"}`,
      status: w == null ? "unreadable" : ok ? "confirmed" : "refuted",
      detail: w == null
        ? "file not found in the supplied checkout"
        : ok
          ? `\`${finding.symbol}\` found within the cited window`
          : `\`${finding.symbol}\` NOT found near the cited line`,
    });
  }

  const refuted = checks.some((c) => c.status === "refuted");

  return {
    checks,
    localConfirmed: localOk,
    consumersChecked,
    consumersConfirmed,
    refuted,
    // Only a confirmed changed symbol with no refuted citation is safe to act
    // on. Consumer citations that could not be opened neither confirm nor
    // refute; they are reported and do not by themselves block.
    verified: localOk && !refuted,
  };
}

// The decision rule. Deliberately narrow: it fires only where BOTH Entire
// products agree, and refuses to fire on anything either product could not
// establish.
export function decide(result, { requireVerified = true } = {}) {
  const intent = result.intent ?? {};
  const reasons = [];
  const blocking = [];

  for (const f of result.findings ?? []) {
    if (!f.breaking) continue;
    // unmentionedRepos is populated only when the transcript read was
    // complete; unacknowledgedRepos is the demoted form from a partial read
    // and must never gate a merge. This is the Curveball constraint applied
    // to an action rather than to a report.
    if (!f.unmentionedRepos?.length) continue;
    if (requireVerified && !f.verification?.verified) {
      reasons.push(
        `${f.symbol}: contract-breaking and unmentioned, but citation not verified - warning only`,
      );
      continue;
    }
    blocking.push(f);
  }

  if (!intent.canAssertAbsence) {
    reasons.push(
      `intent read was ${intent.completeness ?? "unavailable"}` +
      (intent.total ? ` (${intent.resolved}/${intent.total} transcripts)` : "") +
      " - absence of a mention is not evidence, so no finding can gate the merge",
    );
  }

  return {
    action: blocking.length ? "block" : "allow",
    blocking,
    reasons,
    exitCode: blocking.length ? 1 : 0,
  };
}

export function renderDecision(result, decision) {
  const out = [];
  out.push("");
  out.push("## Decision");
  out.push("");

  if (decision.action === "block") {
    out.push(
      `**BLOCK** - ${decision.blocking.length} contract-breaking change(s) reach ` +
      "another repo and are absent from a complete reading of the author's " +
      "checkpoint intent.",
    );
    out.push("");
    for (const f of decision.blocking) {
      out.push(
        `- \`${f.symbol}\` (${f.changeType}) -> ` +
        f.unmentionedRepos.map((r) => `\`${r}\``).join(", "),
      );
    }
  } else {
    out.push("**ALLOW** - no finding met the gate.");
  }

  if (decision.reasons.length) {
    out.push("");
    out.push("Why the gate did not fire more widely:");
    out.push("");
    for (const r of decision.reasons) out.push(`- ${r}`);
  }

  // Verification is shown whether or not it changed the outcome: a reader
  // needs to know which claims were checked against source and which could
  // not be.
  const verified = [];
  for (const f of result.findings ?? []) {
    if (!f.verification) continue;
    const v = f.verification;
    verified.push(
      `- \`${f.symbol}\`: changed symbol ${v.localConfirmed ? "confirmed" : "NOT confirmed"}` +
      `, consumers ${v.consumersConfirmed}/${v.consumersChecked} confirmed` +
      (v.consumersChecked === 0 ? " (no consumer checkout supplied)" : ""),
    );
  }
  if (verified.length) {
    out.push("");
    out.push("Verification against source:");
    out.push("");
    out.push(...verified);
  }

  return out.join("\n");
}
