/**
 * What a listing tool answered, read defensively: JSON (an array, or an
 * object holding one), a Markdown list (`- **Name** \`id\` · 2026-11-02 12:40
 * UTC` with the last message on the next line), or a pipe table (`id | date |
 * from | subject`, with or without its header). Anything else reads as nothing.
 */

export type Entry = {
  key: string;
  name: string;
  subject?: string;
  /** The start of the last message. */
  head?: string;
  /** Epoch ms of the last message. */
  last?: number;
  url?: string;
  /** For a card: the session it is the ticket of. */
  sessionId?: string;
};

const HEAD_CHARS = 200;
const URL_RE = /https?:\/\/[^\s)<>\]`"']+/;
const TIME_RE =
  /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z| ?UTC|[+-]\d{2}:?\d{2})?/;
const SESSION_RE = /session(?:Id)?\W{0,3}([0-9a-f]{8})(?:[0-9a-f-]{28})?\b/i;

function cut(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : flat.slice(0, chars);
}

/** A time as epoch ms: ms, seconds, or any date text `Date.parse` reads ("UTC" read as Z). */
export function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const text = value
    .trim()
    .replace(/ UTC$/, "Z")
    .replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
}

/** "Ada Lovelace <ada@example.com>" → "Ada Lovelace". */
export function personOf(from: string): string {
  const name = from
    .replace(/<[^>]*>/, "")
    .replace(/"/g, "")
    .trim();
  return name === "" ? from.replace(/[<>]/g, "").trim() : name;
}

type Json = Record<string, unknown>;

function pick(record: Json, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const names = value.map((v) =>
      typeof v === "object" && v !== null ? text(pick(v as Json, ["name", "title"])) : text(v),
    );
    const joined = names.filter((n) => n !== undefined).join(", ");
    return joined === "" ? undefined : joined;
  }
  if (typeof value === "object" && value !== null) {
    return text(pick(value as Json, ["text", "body", "snippet", "name", "title"]));
  }
  return undefined;
}

const LIST_KEYS = [
  "chats",
  "threads",
  "conversations",
  "cards",
  "items",
  "messages",
  "results",
  "data",
];

function arrayIn(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return null;
  for (const key of LIST_KEYS) {
    const inner = (value as Json)[key];
    if (Array.isArray(inner)) return inner;
  }
  return null;
}

function entryOfJson(value: unknown, index: number): Entry | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Json;
  const lastMessage = pick(record, [
    "lastMessage",
    "last_message",
    "last",
    "snippet",
    "preview",
    "text",
    "desc",
  ]);
  const from = text(pick(record, ["from", "sender"]));
  const name =
    text(pick(record, ["name", "title", "chat", "participants", "with"])) ??
    (from === undefined ? undefined : personOf(from));
  if (name === undefined) return null;
  const entry: Entry = {
    key:
      text(
        pick(record, ["id", "chatId", "chat_id", "jid", "threadId", "thread_id", "shortLink"]),
      ) ?? `#${index}`,
    name: cut(name, 80),
  };
  return withJsonExtras(entry, record, lastMessage);
}

const TIME_KEYS = [
  "time",
  "date",
  "timestamp",
  "updatedAt",
  "lastActivity",
  "dateLastActivity",
  "at",
];

/** The optional fields of a JSON entry: subject, head, time, link and session. */
function withJsonExtras(entry: Entry, record: Json, lastMessage: unknown): Entry {
  const subject = text(pick(record, ["subject"]));
  if (subject !== undefined) entry.subject = cut(subject, 120);
  const head = text(lastMessage);
  if (head !== undefined) entry.head = cut(head, HEAD_CHARS);
  const inner =
    typeof lastMessage === "object" && lastMessage !== null ? (lastMessage as Json) : {};
  const last = timeOf(pick(record, TIME_KEYS)) ?? timeOf(pick(inner, TIME_KEYS));
  if (last !== undefined) entry.last = last;
  const url = text(pick(record, ["url", "link", "shortUrl", "permalink", "webLink"]));
  if (url !== undefined && /^https?:\/\//.test(url)) entry.url = url;
  const session = text(pick(record, ["sessionId", "session_id", "session"]));
  if (session !== undefined && /^[0-9a-f]{8}/i.test(session)) entry.sessionId = session;
  return entry;
}

function parseJson(raw: string): Entry[] | null {
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  if (!body.startsWith("[") && !body.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const list = arrayIn(value);
  if (list === null) return null;
  return list.flatMap((item, i) => entryOfJson(item, i) ?? []);
}

function entryOfBullet(line: string, more: string[], index: number): Entry | null {
  const bold = line.match(/\*\*(.+?)\*\*/) ?? line.match(/\[([^\]]+)\]\(/);
  const name = bold?.[1] ?? line.replace(/^\s*[-*]\s+/, "").split(/ · | \| | — /)[0];
  if (name === undefined || name.trim() === "") return null;
  const all = [line, ...more].join("\n");
  const entry: Entry = {
    key: line.match(/`([^`]+)`/)?.[1] ?? `#${index}`,
    name: cut(name, 80),
  };
  const head = more
    .map((m) => m.trim())
    .filter((m) => m !== "")
    .join(" ");
  if (head !== "") entry.head = cut(head, HEAD_CHARS);
  const time = line.match(TIME_RE)?.[0];
  const last = time === undefined ? undefined : timeOf(time);
  if (last !== undefined) entry.last = last;
  const url = all.match(URL_RE)?.[0];
  if (url !== undefined) entry.url = url;
  const session = all.match(SESSION_RE)?.[1];
  if (session !== undefined) entry.sessionId = session.toLowerCase();
  return entry;
}

function parseBullets(raw: string): Entry[] {
  const lines = raw.split(/\r?\n/);
  const entries: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/^\s{0,1}[-*]\s+/.test(line)) continue;
    const more: string[] = [];
    while (
      i + 1 < lines.length &&
      /^\s{2,}\S/.test(lines[i + 1] ?? "") &&
      !/^\s*[-*]\s+\*\*/.test(lines[i + 1] ?? "")
    ) {
      more.push(lines[i + 1] ?? "");
      i++;
    }
    const entry = entryOfBullet(line, more, entries.length);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const HEADER_WORDS = new Set([
  "id",
  "thread_id",
  "date",
  "from",
  "subject",
  "messages",
  "name",
  "time",
  "read",
  "attachments",
  "url",
]);

function isHeader(row: string[]): boolean {
  return row.filter((cell) => HEADER_WORDS.has(cell.toLowerCase())).length >= 2;
}

function entryOfRow(row: string[], columns: string[], index: number): Entry | null {
  const at = (name: string): string | undefined => {
    const i = columns.indexOf(name);
    const cell = i === -1 ? undefined : row[i];
    return cell === undefined || cell === "" || cell === "-" ? undefined : cell;
  };
  const from = at("from") ?? at("name");
  if (from === undefined) return null;
  const entry: Entry = {
    key: at("id") ?? at("thread_id") ?? `#${index}`,
    name: cut(personOf(from), 80),
  };
  const subject = at("subject");
  if (subject !== undefined) entry.subject = cut(subject, 120);
  const last = timeOf(at("date") ?? at("time"));
  if (last !== undefined) entry.last = last;
  const url = row.join(" ").match(URL_RE)?.[0];
  if (url !== undefined) entry.url = url;
  return entry;
}

function parseTable(raw: string, defaultColumns: readonly string[]): Entry[] {
  let columns: string[] | null = null;
  const entries: Entry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes("|") || /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)) continue;
    const row = cells(line);
    if (row.length < 3) continue;
    if (isHeader(row)) {
      columns = row.map((cell) => cell.toLowerCase());
      continue;
    }
    const entry = entryOfRow(row, columns ?? [...defaultColumns], entries.length);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * Every entry the answer lists, whatever its form. `columns` names a pipe
 * table's columns when it comes without a header (gmail_search's
 * `thread_id | messages | date | from | subject`).
 */
export function parseListing(
  raw: string,
  columns: readonly string[] = ["id", "date", "from", "subject"],
): Entry[] {
  const json = parseJson(raw);
  if (json !== null) return json;
  const bullets = parseBullets(raw);
  if (bullets.length > 0) return bullets;
  return parseTable(raw, columns);
}
