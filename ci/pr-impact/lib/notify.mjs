// notify: the outward half of ACT - telling the downstream repo it is about
// to break.
//
// This writes to repositories the author of the change does not own, so the
// default is a dry run. Nothing is created unless --notify --no-dry-run is
// passed explicitly, and the body always cites the exact call sites so the
// receiving maintainer can verify the claim rather than trust it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MARKER = "<!-- pr-impact -->";

export function issueFor(finding, repoKey) {
  const sites = (finding.consumers ?? [])
    .filter((c) => c.repoKey === repoKey)
    .map((c) => `- \`${c.file ?? "?"}:${c.line ?? "?"}\` (${c.type})`);

  const title = `Upstream contract change: \`${finding.symbol}\` (${finding.changeType})`;

  const body = [
    MARKER,
    "",
    `An upstream change to \`${finding.symbol}\` (${finding.kind}, ` +
    `**${finding.changeType}**) at \`${finding.file}:${finding.line ?? "?"}\` ` +
    "reaches this repository.",
    "",
    "Call sites detected here:",
    "",
    ...sites,
    "",
    "Detected by cross-repo resolution of Entire Graph external relations. " +
    "Citations resolve to the enclosing function rather than the exact call " +
    "line, so please confirm against source before acting.",
  ].join("\n");

  return { repoKey, title, body, sites: sites.length };
}

function ghRepo(repoKey) {
  // gh/owner/name -> owner/name; anything else is not addressable on GitHub.
  const m = repoKey?.match(/^gh\/(.+\/.+)$/);
  return m ? m[1] : null;
}

export async function notifyConsumers(blocking, { dryRun = true } = {}) {
  const log = [];
  const created = [];

  for (const finding of blocking) {
    // Only repos the gate actually blocked on: notifying every consumer of
    // every change would be spam, and would train maintainers to ignore it.
    for (const repoKey of finding.unmentionedRepos ?? []) {
      const target = ghRepo(repoKey);
      const issue = issueFor(finding, repoKey);

      if (!target) {
        log.push(`notify: ${repoKey} is not a GitHub repo key; skipped`);
        continue;
      }
      if (dryRun) {
        log.push(`notify [dry-run] ${target}: "${issue.title}" (${issue.sites} site(s))`);
        created.push({ ...issue, dryRun: true });
        continue;
      }

      try {
        const { stdout } = await execFileAsync("gh", [
          "api", `repos/${target}/issues`,
          "-f", `title=${issue.title}`,
          "-f", `body=${issue.body}`,
        ], { encoding: "utf8" });
        const url = JSON.parse(stdout).html_url;
        log.push(`notify: opened ${url}`);
        created.push({ ...issue, url });
      } catch (err) {
        // A notification failure must not fail the check: the gate's exit
        // code already carries the decision.
        log.push(`notify: ${target} failed: ${(err.stderr || err.message).toString().trim().slice(0, 200)}`);
      }
    }
  }

  return { log, created };
}
