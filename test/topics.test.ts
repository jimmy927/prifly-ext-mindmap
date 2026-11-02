import { describe, expect, test } from "bun:test";
import { louvain } from "../cluster";
import { EMBED_GAP_MS, EMBED_MODEL, type Embed, Embedder, embedText } from "../embed";
import { entitiesOf, entityEdges, pairKey } from "../entities";
import { keepConversations, MAX_CONVERSATIONS } from "../sources";
import { workOut } from "../topics";
import type { Item } from "../types";
import { fakeState, item } from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const HOUR = 3_600_000;

const sid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function chat(key: string, name: string, head: string, fields: Partial<Item> = {}): Item {
  return item({
    id: `c:whatsapp_chats:${key}`,
    kind: "conversation",
    title: name,
    name,
    repo: "WhatsApp",
    head,
    last: NOW - HOUR,
    ...fields,
  });
}

function mail(key: string, name: string, address: string, subject: string): Item {
  return item({
    id: `c:gmail_search:${key}`,
    kind: "conversation",
    title: name,
    name,
    address,
    repo: "Gmail",
    subject,
    last: NOW - 2 * HOUR,
  });
}

/** Invented work: three people, two repositories, a card, across WhatsApp and Gmail. */
function world(): { sessions: Item[]; others: Item[] } {
  const sessions = [
    item({ id: sid(1), title: "Reply to Ada about the refund", repo: "shop" }),
    item({ id: sid(2), title: "Checkout redesign", repo: "shop" }),
    item({ id: sid(3), title: "Tax report for Bob", repo: "books" }),
    item({ id: sid(4), title: "Invoice export", repo: "books" }),
    item({ id: sid(5), title: "Onboard Cleo at Nordwind", repo: "crm" }),
  ];
  const others = [
    chat("ada", "Ada Lovelace", "Did the refund go through?"),
    mail("m1", "Ada Lovelace", "ada@lovelace-labs.com", "Refund for order 1042"),
    chat("bob", "Bob Builder", "The tax numbers are in"),
    mail("m2", "Bob Builder", "bob@builder-ab.se", "Q3 tax report"),
    mail("m3", "Cleo Nordin", "cleo@nordwind.se", "Welcome call next week"),
    chat("cleo", "Cleo Nordin", "See you Thursday"),
    item({ id: "k:c1", kind: "card", title: "Checkout redesign", repo: "Trello" }),
  ];
  return { sessions, others };
}

function run(input = world(), previous = new Map<string, string>(), nextId = 1) {
  return workOut({ ...input, vectorOf: () => undefined, previous, nextId, now: NOW });
}

describe("shared entities", () => {
  test("a WhatsApp chat, a mail and a session naming the same person are linked across services", () => {
    const items = [
      item({ id: sid(1), title: "Reply to Ada about the refund", repo: "shop" }),
      chat("ada", "Ada Lovelace", "Did the refund go through?"),
      mail("m1", "Ada Lovelace", "ada@lovelace-labs.com", "Refund for order 1042"),
    ];
    const edges = new Map(entityEdges(entitiesOf(items)).map((e) => [pairKey(e.a, e.b), e]));
    const [s, w, g] = items.map((i) => i.id);
    for (const [a, b] of [
      [s, w],
      [s, g],
      [w, g],
    ]) {
      expect(edges.get(pairKey(a ?? "", b ?? ""))?.label).toBe("Ada");
    }
  });

  test("a mail naming a repository links to its session; the service's name never does", () => {
    const items = [
      item({ id: sid(1), title: "Fix the build", repo: "widgets" }),
      mail("m1", "CI Robot", "ci@robots.dev", "[widgets] build failed on main"),
      chat("x", "Gmail", "gmail gmail"),
      mail("m2", "Someone", "s@example.org", "Your Gmail storage"),
    ];
    const edges = entityEdges(entitiesOf(items));
    expect(
      edges.find((e) => pairKey(e.a, e.b) === pairKey(sid(1), "c:gmail_search:m1"))?.label,
    ).toBe("widgets");
    expect(edges.some((e) => e.label.toLowerCase() === "gmail")).toBe(false);
  });

  test("ticket ids tie a card to a session", () => {
    const items = [
      item({ id: sid(1), title: "SHOP-12: fix the button", repo: "shop" }),
      item({ id: "k:1", kind: "card", title: "SHOP-12 checkout button", repo: "Trello" }),
    ];
    expect(entityEdges(entitiesOf(items))[0]?.label).toBe("SHOP-12");
  });
});

describe("clustering", () => {
  test("is deterministic, and two cliques joined by one edge stay two", () => {
    const row = (pairs: [number, number][]) => new Map(pairs);
    const adj = [
      row([
        [1, 1],
        [2, 1],
      ]),
      row([
        [0, 1],
        [2, 1],
      ]),
      row([
        [0, 1],
        [1, 1],
        [3, 0.1],
      ]),
      row([
        [2, 0.1],
        [4, 1],
        [5, 1],
      ]),
      row([
        [3, 1],
        [5, 1],
      ]),
      row([
        [3, 1],
        [4, 1],
      ]),
    ];
    const init = [0, 1, 2, 3, 4, 5];
    expect(louvain(adj, init)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(louvain(adj, init)).toEqual(louvain(adj, init));
  });

  test("topics mix kinds and services; none is all one service", () => {
    const worked = run();
    const byId = new Map(worked.items.map((i) => [i.id, i]));
    const ada = worked.topicOf.get("c:whatsapp_chats:ada");
    expect(worked.topicOf.get("c:gmail_search:m1")).toBe(ada ?? "");
    expect(worked.topicOf.get(sid(1))).toBe(ada ?? "");
    for (const topic of worked.topics) {
      const services = new Set(
        topic.members.map((m) => (m.kind === "session" ? "session" : m.repo)),
      );
      if (topic.members.length > 1) expect(services.size).toBeGreaterThan(1);
    }
    const mixed = worked.topics.filter((t) => new Set(t.members.map((m) => m.kind)).size > 1);
    expect(mixed.length).toBeGreaterThanOrEqual(3);
    expect(byId.size).toBe(12);
  });

  test("related links join the person's chat and mail, labelled by the person", () => {
    const worked = run();
    const link = worked.related.find(
      (r) => pairKey(r.a, r.b) === pairKey("c:whatsapp_chats:ada", "c:gmail_search:m1"),
    );
    expect(link?.label).toBe("Ada");
    expect(worked.related.length).toBeLessThanOrEqual(20);
  });

  test("adding one item keeps every other item's topic and the topics' ids", () => {
    const first = run();
    const input = world();
    input.others.push(chat("dan", "Dan Brown", "Lunch?"));
    input.sessions.push(item({ id: sid(9), title: "Refund webhook for Ada", repo: "shop" }));
    const second = run(input, first.topicOf, first.nextId);
    for (const [id, topic] of first.topicOf) expect(second.topicOf.get(id)).toBe(topic);
    expect(second.topicOf.get(sid(9))).toBe(first.topicOf.get(sid(1)) ?? "");
  });
});

describe("embeddings", () => {
  function embedder() {
    const sent: string[][] = [];
    const embed: Embed = async (_key, model, texts) => {
      expect(model).toBe(EMBED_MODEL);
      sent.push(texts);
      return texts.map((text) => Array.from({ length: 300 }, (_, i) => (text.length + i) % 7));
    };
    const state = fakeState();
    return { e: new Embedder({ key: async () => "k", embed, state }), sent, state };
  }

  test("uses EmbeddingGemma, sends each item's own words, never its service", async () => {
    expect(EMBED_MODEL).toBe("google/embeddinggemma-300m");
    const { e, sent } = embedder();
    const items = world().others;
    await e.update(items, 0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.join(" ")).not.toContain("WhatsApp");
    expect(sent[0]).toContain(embedText(items[0] ?? item({ id: "x" })));
    expect(e.vectorOf(items[0] ?? item({ id: "x" }))).toHaveLength(256);
  });

  test("the cache skips unchanged texts, and at most one call a minute", async () => {
    const { e, sent, state } = embedder();
    const items = world().others;
    await e.update(items, 0);
    await e.update(items, EMBED_GAP_MS * 3);
    expect(sent).toHaveLength(1);
    const changed = items.map((i) =>
      i.id === "c:whatsapp_chats:ada" ? { ...i, head: "Thanks!" } : i,
    );
    await e.update(changed, EMBED_GAP_MS * 3 + 1);
    await e.update(changed, EMBED_GAP_MS * 3 + 2);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toHaveLength(1);
    await e.update(changed, EMBED_GAP_MS * 4);
    expect(sent).toHaveLength(2);
    // A restart reads the cached vectors and sends nothing.
    const again = new Embedder({ key: async () => "k", embed: async () => [], state });
    await again.load();
    expect(again.due(changed, EMBED_GAP_MS * 10)).toBe(false);
  });
});

describe("wider intake", () => {
  test("keeps the 20 best-matching conversations, matched first, recency breaking ties", () => {
    const recent = Array.from({ length: 30 }, (_, i) =>
      chat(`r${i}`, `Person ${i}`, "hello", { last: NOW - i * HOUR }),
    );
    const matched = [
      chat("m-old", "Matched old", "x", { last: NOW - 10 * 24 * HOUR }),
      chat("m-best", "Matched best", "x", { last: NOW - 20 * HOUR }),
      chat("m-tie", "Matched tie", "x", { last: NOW - 2 * HOUR }),
    ];
    const scores = new Map([
      ["c:whatsapp_chats:m-old", 1],
      ["c:whatsapp_chats:m-best", 3],
      ["c:whatsapp_chats:m-tie", 1],
    ]);
    const kept = keepConversations([...recent, ...matched], (i) => scores.get(i.id) ?? 0, NOW);
    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    expect(kept.slice(0, 3).map((i) => i.id)).toEqual([
      "c:whatsapp_chats:m-best",
      "c:whatsapp_chats:m-tie",
      "c:whatsapp_chats:m-old",
    ]);
    expect(kept[3]?.id).toBe("c:whatsapp_chats:r0");
  });

  test("an old conversation that names a session's person is kept over recent strangers", () => {
    const input = world();
    const strangers = Array.from({ length: 25 }, (_, i) =>
      chat(`s${i}`, `Stranger ${i}`, "hi", { last: NOW - i * 60_000 }),
    );
    input.others.push(...strangers);
    input.others.push(chat("ada-old", "Ada", "About the refund", { last: NOW - 30 * 24 * HOUR }));
    const worked = run(input);
    const ids = worked.items.map((i) => i.id);
    expect(ids).toContain("c:whatsapp_chats:ada-old");
    expect(worked.items.filter((i) => i.kind === "conversation")).toHaveLength(MAX_CONVERSATIONS);
  });
});
