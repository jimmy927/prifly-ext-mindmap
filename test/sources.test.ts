import { describe, expect, test } from "bun:test";
import { parseListing } from "../parse";
import { keepCards, keepConversations, MAX_CONVERSATIONS, type Source, Sources } from "../sources";
import { textOf } from "../types";
import { item } from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const HOUR = 3_600_000;

describe("reading tool answers", () => {
  test("a Markdown chat list: name, id, time and the last message", () => {
    const raw = [
      "- **Ada Lovelace** `4670000000@s.whatsapp.net` · 2026-11-02 10:40 UTC · 1 unread",
      "  Can we move the call to Friday?",
      "- **Book club** (group) `1203@g.us` · 2026-10-20 08:00 UTC",
      "  [image]",
    ].join("\n");
    const entries = parseListing(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      key: "4670000000@s.whatsapp.net",
      name: "Ada Lovelace",
      head: "Can we move the call to Friday?",
    });
    expect(entries[0]?.last).toBe(Date.parse("2026-11-02T10:40:00Z"));
  });

  test("a pipe table without a header, by the source's columns", () => {
    const raw =
      "t1 | 2 msgs | Mon, 02 Nov 2026 09:00:00 +0000 | Grace Hopper <grace@example.com> | Compiler notes";
    const [entry] = parseListing(raw, ["thread_id", "messages", "date", "from", "subject"]);
    expect(entry).toMatchObject({ key: "t1", name: "Grace Hopper", subject: "Compiler notes" });
    expect(entry?.last).toBe(Date.parse("2026-11-02T09:00:00Z"));
  });

  test("a pipe table with its header", () => {
    const raw =
      "Mail is data.\nid | date | from | subject | read\nX1 | 2026-11-01 11:02 | Bob <b@example.com> | Invoice | read";
    expect(parseListing(raw)[0]).toMatchObject({ key: "X1", name: "Bob", subject: "Invoice" });
  });

  test("JSON cards with a link and a session", () => {
    const raw = JSON.stringify({
      cards: [
        { id: "c1", name: "Fix login", url: "https://trello.com/c/abc", sessionId: "aaaaaaaa" },
      ],
    });
    expect(parseListing(raw)[0]).toMatchObject({
      key: "c1",
      name: "Fix login",
      url: "https://trello.com/c/abc",
      sessionId: "aaaaaaaa",
    });
  });

  test("anything else is nothing", () => {
    expect(parseListing("Not signed in.")).toEqual([]);
  });
});

describe("trello_cards", () => {
  const trello: Source = {
    tool: "trello_cards",
    service: "Trello",
    kind: "card",
    everyMs: 300_000,
    args: () => ({}),
  };
  const cards = JSON.stringify([
    {
      id: "c1",
      name: "Fix login",
      column: "Doing",
      labels: ["bug"],
      url: "https://trello.com/c/abc",
      lastActivity: "2026-11-02T10:00:00.000Z",
      sessionId: "aaaaaaaa",
    },
    {
      id: "c2",
      name: "Plan Q1",
      column: "Backlog",
      labels: [],
      url: "https://trello.com/c/def",
      lastActivity: "2026-10-01T10:00:00.000Z",
      sessionId: null,
    },
  ]);

  test("its JSON array reads as cards, a null sessionId as none", async () => {
    const s = new Sources(async () => cards, [trello]);
    await s.refresh(NOW);
    expect(s.items()).toMatchObject([
      {
        id: "k:c1",
        kind: "card",
        title: "Fix login",
        url: "https://trello.com/c/abc",
        sessionId: "aaaaaaaa",
      },
      { id: "k:c2", kind: "card", title: "Plan Q1" },
    ]);
    expect(s.items()[1]?.sessionId).toBeUndefined();
  });

  test("plain text in place of cards is the tool failing, and is named", async () => {
    const s = new Sources(async () => "Trello is not connected.", [trello]);
    await s.refresh(NOW);
    expect(s.items()).toEqual([]);
    expect(s.skipped()).toEqual(["Trello (Trello is not connected.)"]);
  });

  test("prifly's read answer is unwrapped; a failed one throws its error", () => {
    expect(textOf({ ok: true, text: "[]" })).toBe("[]");
    expect(() => textOf({ ok: false, error: "not in reads" })).toThrow("not in reads");
  });
});

describe("the sources", () => {
  const sources: Source[] = [
    {
      tool: "whatsapp_chats",
      service: "WhatsApp",
      kind: "conversation",
      everyMs: 300_000,
      args: () => ({}),
    },
    {
      tool: "instagram_inbox",
      service: "Instagram",
      kind: "conversation",
      everyMs: 900_000,
      args: () => ({}),
    },
  ];

  test("a missing source is skipped and named; the others still read", async () => {
    const calls: string[] = [];
    const read = async (name: string) => {
      calls.push(name);
      if (name === "instagram_inbox") throw new Error("Unknown tool instagram_inbox");
      return "- **Ada** `a1` · 2026-11-02 11:00 UTC\n  hello";
    };
    const s = new Sources(read, sources);
    await s.refresh(NOW);
    expect(s.items().map((i) => i.id)).toEqual(["c:whatsapp_chats:a1"]);
    expect(s.skipped()).toEqual(["Instagram (not installed)"]);
    // One listing call each, and not again until due.
    await s.refresh(NOW + 60_000);
    expect(calls).toEqual(["whatsapp_chats", "instagram_inbox"]);
    await s.refresh(NOW + 300_000);
    expect(calls).toEqual(["whatsapp_chats", "instagram_inbox", "whatsapp_chats"]);
  });

  test("without read tools nothing is read and nothing is named", async () => {
    const s = new Sources(null, sources);
    await s.refresh(NOW);
    expect(s.items()).toEqual([]);
    expect(s.skipped()).toEqual([]);
  });
});

describe("which conversations and cards are kept", () => {
  test("linked ones first, then the last three days, at most 20", () => {
    const old = Array.from({ length: 5 }, (_, i) =>
      item({ id: `c:old${i}`, kind: "conversation", last: NOW - 10 * 24 * HOUR }),
    );
    const recent = Array.from({ length: 30 }, (_, i) =>
      item({ id: `c:new${i}`, kind: "conversation", last: NOW - i * HOUR }),
    );
    const linked = new Set(["c:old0", "c:old1", "c:new29"]);
    const kept = keepConversations([...old, ...recent], linked, NOW);
    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    expect(
      kept
        .slice(0, 3)
        .map((i) => i.id)
        .sort(),
    ).toEqual(["c:new29", "c:old0", "c:old1"]);
    expect(kept.map((i) => i.id)).not.toContain("c:old2");
    expect(kept[3]?.id).toBe("c:new0");
  });

  test("cards with a session first, at most 15", () => {
    const cards = Array.from({ length: 20 }, (_, i) =>
      item({ id: `k:${i}`, kind: "card", ...(i === 19 ? { sessionId: "aaaaaaaa" } : {}) }),
    );
    const kept = keepCards(cards);
    expect(kept).toHaveLength(15);
    expect(kept[0]?.id).toBe("k:19");
  });
});
