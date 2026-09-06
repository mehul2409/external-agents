// Single ingestion layer for Entire checkpoint transcripts.
//
// The integrated agent shipped a new transcript and lifecycle event format
// while existing users still emit the original one. Both must work, and
// neither may be trusted to be complete.
//
// The pipeline is deliberately one-way and format-agnostic after step two:
//
//   raw -> detectFormat()  -> 'legacy-text' | 'jsonl-v2' | 'unknown'
//       -> parse<format>() -> the ONLY per-format code in the codebase
//       -> normalize()     -> { events, unknownEvents, completeness, ... }
//
// Everything downstream consumes the normalized shape. Adding a third format
// means adding a detector branch and a parser, never touching analyze(),
// the scorer or the renderers.

// Highest schema major this parser was written against. A newer document is
// still parsed - refusing to read it would be worse than reading it partially
// - but the mismatch is recorded rather than swallowed, because a silent
// schema shift is exactly the failure this module exists to prevent.
export const SUPPORTED_SCHEMA_MAJOR = 2;

// Normalized event kinds. Per-format parsers map into this set and nothing
// else; anything they cannot map becomes an unknown event.
export const EVENT_KINDS = new Set([
  "intent", "summary", "user", "assistant", "tool", "lifecycle",
]);

// jsonl-v2 event type -> normalized kind. Lifecycle events carry no intent
// text but are legitimate, known events: they prove the stream is readable
// and they bound its completeness.
// jsonl-v2 event name -> normalized kind.
//
// The names on the left are the integrated agent's own vocabulary, taken from
// its published session fixture. The aliases beneath each group exist because
// the discriminator field and the event names are the two things most likely
// to drift again; absorbing a rename here costs one line and never reaches
// the pipeline.
//
// Lifecycle events carry no intent text but are legitimate, known events:
// they prove the stream is readable and they bound its completeness.
const JSONL_EVENT_KINDS = new Map(Object.entries({
  // intent
  checkpoint_created: "intent",   // carries `intent`, `summary`, `git_commit`
  checkpoint_committed: "intent",
  intent: "intent",
  checkpoint_intent: "intent",
  // summary
  summary: "summary",
  checkpoint_summary: "summary",
  // conversation
  user_prompt: "user",
  user: "user",
  user_message: "user",
  prompt: "user",
  agent_response: "assistant",
  assistant: "assistant",
  assistant_message: "assistant",
  response: "assistant",
  // work performed
  tool_call: "tool",
  tool_result: "tool",
  tool: "tool",
  tool_use: "tool",
  file_read: "tool",
  file_changed: "tool",
  // lifecycle
  session_started: "lifecycle",
  session_ended: "lifecycle",
  session_start: "lifecycle",
  session_end: "lifecycle",
  usage: "lifecycle",
}));

// Lifecycle events that open and close a stream. A stream that opens and
// never closes was cut off mid-write.
const OPENING_EVENTS = new Set(["session_started", "session_start"]);
const CLOSING_EVENTS = new Set([
  "session_ended", "session_end", "checkpoint_created", "checkpoint_committed",
]);

// Structural markers of the original renderer's output. Detection keys on
// STRUCTURE, never on prose: the previous implementation decided whether a
// transcript was readable by matching English sentences, so a wording change
// upstream would silently flip "unreadable" to "readable" and let a failure
// message be scored as intent.
const LEGACY_MARKERS = [
  /^\u25cf Checkpoint [0-9a-f]{6,}/m,   // "● Checkpoint 0874724419f8"
  /^## Intent$/m,
  /^## Summary$/m,
  /^\u2500{3,}/m,                        // the box-drawing transcript rule
  /^\[(?:User|Assistant|Tool)\]/m,
];

// A row of the human-rendered `entire checkpoint list` table. This is a weak
// source and is labelled as such downstream, but parsing it belongs here with
// the other format-specific code rather than inline in the caller.
const LEGACY_LIST_ROW =
  /^\s+(\d\d)-(\d\d)\s+\d\d:\d\d\s+\(([0-9a-f]{7,40})\)\s+(.+)$/;

const LEGACY_SPEAKER = /^\[(User|Assistant|Tool)\]\s?([\s\S]*)$/;

// ------------------------------------------------------------------ detect

/**
 * Classify a raw transcript document.
 *
 * Returns 'unknown' for anything unrecognisable, including the CLI's
 * "no checkpoint here" output. That is the point: unreadable is a structural
 * verdict, not a string match, so it survives a change of wording.
 */
export function detectFormat(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return "unknown";

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let jsonObjects = 0;
  let typed = 0;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    jsonObjects++;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object" && eventNameOf(rec)) typed++;
    } catch { /* malformed lines are counted by the parser, not the detector */ }
  }
  // A JSONL document is one whose lines are predominantly JSON objects. A
  // truncated final line must not disqualify it, so this is a majority test
  // rather than an all-or-nothing one.
  if (typed > 0 && jsonObjects * 2 >= lines.length) return "jsonl-v2";

  if (LEGACY_MARKERS.some((re) => re.test(text))) return "legacy-text";
  if (lines.some((l) => LEGACY_LIST_ROW.test(`  ${l}`))) return "legacy-text";
  return "unknown";
}

// ------------------------------------------------------- per-format parsers

/**
 * Parse the original human-rendered transcript, or a `checkpoint list` table.
 * The ONLY place legacy layout knowledge lives.
 */
export function parseLegacyText(raw) {
  const text = typeof raw === "string" ? raw : "";
  const events = [];
  const unknown = [];
  let sawTranscriptRule = false;
  // The renderer emits a metadata header, then "## Intent"/"## Summary"
  // sections, then a labelled rule, then the conversation. Headings are
  // structural ONLY before that rule: once inside the conversation, a "##"
  // line is something a person typed, not a section the renderer produced.
  let inTranscript = false;
  let section = null;      // accumulating "## Intent" / "## Summary" body
  let buffer = [];
  let current = null;      // the speaker turn currently being accumulated

  const flushSection = () => {
    if (section && buffer.length) {
      const body = buffer.join("\n").trim();
      if (body) events.push({ kind: section, text: body, source: "legacy-text" });
    }
    section = null;
    buffer = [];
  };
  const flushTurn = () => {
    if (current) {
      current.text = current.lines.join("\n").trim();
      delete current.lines;
      events.push(current);
    }
    current = null;
  };

  for (const line of text.split("\n")) {
    // Any box-drawing rule ends the header. The conversation rule is labelled
    // ("── Transcript (checkpoint scope) ───") and so begins with only two
    // box characters - matching on three would miss it entirely and drop
    // every message body that follows.
    if (/^\u2500{2,}/.test(line)) {
      flushSection();
      flushTurn();
      sawTranscriptRule = true;
      if (/transcript/i.test(line)) inTranscript = true;
      continue;
    }

    const speaker = line.match(LEGACY_SPEAKER);
    if (speaker) {
      flushSection();
      flushTurn();
      // A speaker marker also proves we are in the conversation, even if the
      // labelled rule was absent or reworded.
      inTranscript = true;
      current = {
        kind: speaker[1].toLowerCase(),
        lines: [speaker[2]],
        source: "legacy-text",
      };
      continue;
    }

    if (!inTranscript) {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        flushSection();
        const name = heading[1].toLowerCase();
        if (name === "intent") section = "intent";
        else if (name === "summary") section = "summary";
        else if (name === "files" || name.startsWith("files")) section = null;
        else {
          // A heading the original renderer never emitted, in the position
          // where it emits its own. Not fatal - record it and keep reading.
          unknown.push(`heading:${name}`);
          section = null;
        }
        continue;
      }

      const row = line.match(LEGACY_LIST_ROW);
      if (row) {
        flushSection();
        events.push({
          kind: "summary", text: row[4].trim(), commit: row[3],
          source: "legacy-list",
        });
        continue;
      }
    }

    // Continuation. A turn spans every line up to the next speaker marker;
    // capturing only the first line discarded ~78% of the conversation and
    // biased intent matching toward false "never mentioned" verdicts.
    if (current) current.lines.push(line);
    else if (section) buffer.push(line);
  }
  flushSection();
  flushTurn();

  // A rendered transcript whose body never arrived. The section rule is
  // present, so the document is genuinely of this format - it is just cut off.
  const truncated = sawTranscriptRule
    && !events.some((e) => e.kind === "user" || e.kind === "assistant");

  return {
    format: "legacy-text",
    events,
    unknownEvents: unknown,
    malformed: 0,
    truncated,
    schemaVersion: null,
  };
}

/**
 * Parse the new line-delimited event stream.
 * The ONLY place jsonl-v2 field knowledge lives.
 */
export function parseJsonlV2(raw) {
  const text = typeof raw === "string" ? raw : "";
  const events = [];
  const unknown = [];
  let malformed = 0;
  let schemaVersion = null;
  let opened = false;
  let closed = false;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Previously these vanished. A malformed line is evidence the document
      // is not intact, so it is counted and it downgrades completeness.
      malformed++;
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) { malformed++; continue; }

    // schema_version is read rather than ignored. Only the first declaration
    // is authoritative; a stream that changes it mid-document is malformed.
    const declared = rec.schema_version ?? rec.schemaVersion;
    if (declared !== undefined && declared !== null) {
      if (schemaVersion === null) schemaVersion = String(declared);
      else if (String(declared) !== schemaVersion) malformed++;
    }

    const type = eventNameOf(rec);
    if (!type) { malformed++; continue; }

    if (OPENING_EVENTS.has(type)) opened = true;
    if (CLOSING_EVENTS.has(type)) closed = true;

    const kind = JSONL_EVENT_KINDS.get(type);
    if (!kind) {
      // An event type this build has never seen. Requirement: never throw,
      // always surface. It contributes no text, so it cannot influence a
      // finding it was not understood well enough to support.
      unknown.push(type);
      continue;
    }

    // checkpoint_created names the commit it belongs to; keep it so a
    // document can identify itself rather than relying on the caller.
    const commit = typeof rec.git_commit === "string" ? rec.git_commit : undefined;

    // One record, two normalized events. The original format renders
    // `## Intent` and `## Summary` as separate sections, and the new format
    // carries both fields on checkpoint_created. Emitting one merged event
    // would make the two formats normalize differently, which is exactly the
    // divergence this layer exists to prevent.
    const summary = typeof rec.summary === "string" ? rec.summary.trim() : "";
    if (kind === "intent" && summary) {
      events.push({ kind: "summary", text: summary, type, source: "jsonl-v2", commit });
      events.push({
        kind, text: extractText(rec, { skip: ["summary"] }), type,
        source: "jsonl-v2", commit,
      });
      continue;
    }

    events.push({ kind, text: extractText(rec), type, source: "jsonl-v2", commit });
  }

  // Opened and never closed means the writer stopped mid-session.
  const truncated = opened && !closed;

  return {
    format: "jsonl-v2",
    events,
    unknownEvents: unknown,
    malformed,
    truncated,
    schemaVersion,
  };
}

// The discriminator. The integrated agent names it `event`; the original
// stream named it `type`. Reading both is what "support both formats" means
// at the field level, and it is one line rather than a forked parser.
function eventNameOf(rec) {
  const name = rec?.event ?? rec?.type;
  return typeof name === "string" && name ? name : null;
}

// Text lives in a different field depending on the event. Tolerant by
// design: an unrecognised carrier yields "" rather than throwing, and an
// event with no text is still a valid event.
function extractText(rec, { skip = [] } = {}) {
  const omit = new Set(skip);
  const pieces = [
    // Free-text turns.
    rec.text, rec.prompt, rec.content,
    rec.message?.content ?? rec.message?.text ?? rec.message,
    // checkpoint_created carries the richest signal we have: the author's
    // own statement of what the change was for, plus what they left open.
    rec.intent, omit.has("summary") ? null : rec.summary,
    Array.isArray(rec.open_questions) ? rec.open_questions.join("\n") : null,
    // Work performed. Paths and repository names matter because intent
    // matching asks whether a consumer repo was mentioned at all, and a file
    // the author touched is a stronger signal than one they merely named.
    rec.path, rec.repository, rec.branch,
    rec.tool, rec.input?.query, rec.input?.command,
    rec.output?.summary, rec.output?.stderr,
    Array.isArray(rec.output?.matches) ? rec.output.matches.join("\n") : null,
  ];
  return pieces.map(flattenContent).filter(Boolean).join("\n");
}

function flattenContent(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((v) => flattenContent(v?.text ?? v?.content ?? v)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") return flattenContent(value.text ?? value.content ?? null);
  return String(value);
}

// ------------------------------------------------------------------ parse

const PARSERS = {
  "legacy-text": parseLegacyText,
  "jsonl-v2": parseJsonlV2,
};

/**
 * Detect and parse one raw document. Never throws on content.
 */
export function parseTranscript(raw) {
  const format = detectFormat(raw);
  const parser = PARSERS[format];
  if (!parser) {
    return {
      format: "unknown", events: [], unknownEvents: [], malformed: 0,
      truncated: false, schemaVersion: null, readable: false, complete: false,
    };
  }
  let parsed;
  try {
    parsed = parser(raw);
  } catch (err) {
    // A parser bug must degrade to "unreadable", never take down the check.
    return {
      format, events: [], unknownEvents: [`parser-error:${err.message}`],
      malformed: 1, truncated: true, schemaVersion: null,
      readable: false, complete: false,
    };
  }

  // A document is readable if we recognised its format and got at least one
  // event out of it. It is complete only if nothing was lost on the way.
  const readable = parsed.events.length > 0;
  const schemaAhead = parsed.schemaVersion !== null
    && Number.parseInt(parsed.schemaVersion, 10) > SUPPORTED_SCHEMA_MAJOR;
  const complete = readable && !parsed.truncated && parsed.malformed === 0 && !schemaAhead;
  return { ...parsed, readable, complete, schemaAhead };
}

// -------------------------------------------------------------- normalize

/**
 * Fold per-commit parse results into the single format-agnostic shape the
 * rest of the tool consumes.
 *
 * `documents` is one entry per commit in range: { commit, raw }.
 *
 * completeness is the contract that replaces the old binary `available`:
 *
 *   'complete'    every commit in range resolved to an intact transcript
 *   'partial'     some did - claims of absence are NOT supportable
 *   'unavailable' none did - structural findings only
 */
export function normalize(documents = []) {
  const docs = Array.isArray(documents) ? documents : [];
  const total = docs.length;

  const events = [];
  const unknownCounts = new Map();
  const schemaVersions = new Set();
  const formats = new Set();
  let resolved = 0;
  let intact = 0;
  let malformed = 0;

  for (const doc of docs) {
    const parsed = parseTranscript(doc?.raw);
    for (const type of parsed.unknownEvents) {
      unknownCounts.set(type, (unknownCounts.get(type) ?? 0) + 1);
    }
    malformed += parsed.malformed;
    if (parsed.schemaVersion) schemaVersions.add(parsed.schemaVersion);
    if (!parsed.readable) continue;

    resolved++;
    formats.add(parsed.format);
    if (parsed.complete) intact++;
    for (const ev of parsed.events) {
      events.push({ ...ev, commit: ev.commit ?? doc?.commit ?? null });
    }
  }

  let completeness;
  if (total === 0 || resolved === 0) completeness = "unavailable";
  // Every commit resolved AND every resolved document was intact. A truncated
  // transcript keeps the run honest at 'partial' even when the count is full.
  else if (resolved === total && intact === total) completeness = "complete";
  else completeness = "partial";

  const unknownEvents = [...unknownCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  // Only 'legacy-list' events come from the weak table source; if that is all
  // we have, downstream should say "summaries" rather than "transcripts".
  const onlySummaries = events.length > 0
    && events.every((e) => e.source === "legacy-list");

  return {
    events,
    unknownEvents,
    unknownEventCount: unknownEvents.reduce((n, u) => n + u.count, 0),
    malformedLines: malformed,
    completeness,
    resolved,
    total,
    intact,
    formats: [...formats].sort(),
    schemaVersions: [...schemaVersions].sort(),
    source: resolved === 0 ? "none" : onlySummaries ? "summary" : "transcript",
    // Lowercased haystack for intent matching. Only text from events we
    // actually understood reaches it.
    text: events.map((e) => e.text).filter(Boolean).join("\n").toLowerCase(),
  };
}

/**
 * True when the run may state that something is absent from intent.
 * Absence of evidence is only evidence of absence if we read everything.
 */
export function canAssertAbsence(normalized) {
  return normalized?.completeness === "complete";
}
