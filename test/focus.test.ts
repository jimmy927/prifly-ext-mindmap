import { expect, test } from "bun:test";
import manifest from "../prifly-extension.json";
import { SOURCES, Sources } from "../sources";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const DAY = 86_400_000;

const SENT = [
  "s1 | 2 msg | Mon, 02 Nov 2026 09:00:00 +0000 | Ada Lovelace <ada@example.com> | Notes",
  "s2 | 1 msg | Mon, 02 Nov 2026 08:00:00 +0000 | Ada Lovelace <ada@example.com> | Plans",
  "s3 | 1 msg | Mon, 02 Nov 2026 07:00:00 +0000 | Grace Hopper <grace@example.com> | Re: Plans",
].join("\n");

const CHATS = [
  "- **Grace Hopper** `g1@lid` · 2026-11-02 10:00 UTC",
  "  See you at five",
  "- **Ada Lovelace** `a1@lid` · 2026-11-02 09:30 UTC",
  "  note to self",
  "- **Book club** (group) `b1@g.us` · 2026-11-01 08:00 UTC",
  "  [image]",
  "- **Old friend** `o1@lid` · 2026-10-20 08:00 UTC",
  "  long ago",
].join("\n");

function fake(answers: Record<string, string>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const read = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (answer === undefined) throw new Error("not installed");
    return answer;
  };
  return { calls, read };
}

test("Telegram is not read: not a source, not in the manifest's reads", async () => {
  expect(SOURCES.map((s) => s.tool)).not.toContain("telegram_chats");
  expect(manifest.reads).not.toContain("telegram_chats");
  const { calls, read } = fake({});
  await new Sources(read).refresh(NOW);
  expect(calls.map((c) => c.name)).not.toContain("telegram_chats");
});

test("WhatsApp: the reader's chat with themselves and chats older than 3 days are dropped", async () => {
  const { read } = fake({ whatsapp_chats: CHATS, gmail_search: SENT });
  const sources = new Sources(
    read,
    SOURCES.filter((s) => s.tool === "whatsapp_chats"),
  );
  await sources.refresh(NOW);
  // "Ada Lovelace" is the name on the sent threads; Old friend is 13 days old.
  expect(sources.items().map((i) => i.title)).toEqual(["Grace Hopper", "Book club"]);
});

test("WhatsApp: the reader's name is looked up once, from the sent Gmail threads", async () => {
  const { calls, read } = fake({ whatsapp_chats: CHATS, gmail_search: SENT });
  const sources = new Sources(
    read,
    SOURCES.filter((s) => s.tool === "whatsapp_chats"),
  );
  await sources.refresh(NOW);
  await sources.refresh(NOW + 10 * 60_000);
  expect(calls.filter((c) => c.name === "gmail_search")).toEqual([
    { name: "gmail_search", args: { query: "in:sent", max: 10 } },
  ]);
  expect(calls.filter((c) => c.name === "whatsapp_chats")).toHaveLength(2);
});

test("WhatsApp: without Gmail the name is unknown, nobody is dropped as the reader, stale chats still are", async () => {
  const { read } = fake({ whatsapp_chats: CHATS });
  const sources = new Sources(
    read,
    SOURCES.filter((s) => s.tool === "whatsapp_chats"),
  );
  await sources.refresh(NOW);
  expect(sources.items().map((i) => i.title)).toEqual([
    "Grace Hopper",
    "Ada Lovelace",
    "Book club",
  ]);
  expect(sources.skipped()).toEqual([]);
});

test("WhatsApp: a chat with no time is dropped", async () => {
  const { read } = fake({ whatsapp_chats: "- **Nobody** `n1@lid`\n  hi", gmail_search: SENT });
  const sources = new Sources(
    read,
    SOURCES.filter((s) => s.tool === "whatsapp_chats"),
  );
  await sources.refresh(NOW);
  expect(sources.items()).toEqual([]);
});

test("Trello: in-progress and this week's cards stay, a done one never does, others only with a session", async () => {
  const card = (id: string, column: string, sessionId: string | null) => ({
    id,
    name: `Card ${id}`,
    column,
    labels: [],
    url: `https://trello.com/c/${id}`,
    lastActivity: new Date(NOW - DAY).toISOString(),
    sessionId,
  });
  const cards = [
    card("c1", "In Progress", null),
    card("c2", "Doing", null),
    card("c3", "Pågår", null),
    card("c4", "Working on it", null),
    card("c5", "In work", null),
    card("c6", "WIP", null),
    card("c7", "Active now", null),
    card("c8", "DONE", "aaaaaaaa-0000-4000-8000-000000000000"),
    card("c9", "Backlog", null),
    card("c10", "Denna Vecka", null),
    card("c11", "Avvaktar", null),
    card("c12", "DONE", null),
  ];
  const { read } = fake({ trello_cards: JSON.stringify(cards) });
  const sources = new Sources(
    read,
    SOURCES.filter((s) => s.tool === "trello_cards"),
  );
  await sources.refresh(NOW);
  expect(sources.items().map((i) => i.id)).toEqual([
    "k:c1",
    "k:c2",
    "k:c3",
    "k:c4",
    "k:c5",
    "k:c6",
    "k:c7",
    "k:c10",
  ]);
});
