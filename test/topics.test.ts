import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { entitiesOf, entityEdges, pairKey } from "../entities";
import { keepConversations, MAX_CONVERSATIONS } from "../sources";
import { MAX_RELATED, pick, relatedOf } from "../topics";
import type { Item } from "../types";
import { item } from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const HOUR = 3_600_000;
const ROOT = join(import.meta.dir, "..");

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

describe("what the model is given", () => {
  test("the pairs that share an entity are the hints, labelled by it, across services first", () => {
    const picked = pick({ ...world(), now: NOW });
    const labelOf = (a: string, b: string) =>
      picked.shared.find((p) => pairKey(p.a, p.b) === pairKey(a, b))?.label;
    expect(labelOf(sid(1), "c:whatsapp_chats:ada")).toBe("Ada");
    expect(labelOf("c:whatsapp_chats:ada", "c:gmail_search:m1")).toBe("Ada");
    expect(picked.items.map((i) => i.id)).toContain("k:c1");
  });

  test("related links join the entity pairs and the model's pairs, minus pairs the entities already tie", () => {
    const picked = pick({ ...world(), now: NOW });
    const found = [
      { a: sid(1), b: "c:gmail_search:m1", label: "same again" },
      { a: sid(3), b: "nowhere", label: "gone" },
    ];
    const related = relatedOf(picked, found);
    expect(
      related.find((r) => pairKey(r.a, r.b) === pairKey(sid(1), "c:gmail_search:m1"))?.label,
    ).toBe("Ada");
    const lone = {
      items: [item({ id: "x1" }), item({ id: "x2" })],
      entities: new Map(),
      shared: [],
    };
    expect(relatedOf(lone, [{ a: "x1", b: "x2", label: "money" }])).toEqual([
      { a: "x1", b: "x2", label: "money" },
    ]);
    expect(related.some((r) => r.b === "nowhere")).toBe(false);
    expect(related.length).toBeLessThanOrEqual(MAX_RELATED);
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
    const picked = pick({ ...input, now: NOW });
    expect(picked.items.map((i) => i.id)).toContain("c:whatsapp_chats:ada-old");
    expect(picked.items.filter((i) => i.kind === "conversation")).toHaveLength(MAX_CONVERSATIONS);
  });
});

describe("no embedding service is left", () => {
  const files = [
    ...readdirSync(ROOT).filter((f) => /\.(ts|js|json|html)$/.test(f) && f !== "bun.lock"),
    ...readdirSync(join(ROOT, "panel")).map((f) => join("panel", f)),
  ].filter((f) => f !== "package.json" && f !== "tsconfig.json" && f !== "biome.json");

  test("no source file mentions DeepInfra, the vault or the models", () => {
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect({ file, hit: /deepinfra|vault|gemma|openai/i.test(text) }).toEqual({
        file,
        hit: false,
      });
    }
  });

  test("the files that called it are gone", () => {
    const names = readdirSync(ROOT);
    for (const gone of ["embed.ts", "deepinfra.ts", "model.ts", "cluster.ts"])
      expect(names).not.toContain(gone);
  });

  test("the manifest asks for the fast tier and no vault entry", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "prifly-extension.json"), "utf8"));
    expect(manifest.vault).toBeUndefined();
    expect(manifest.llm).toEqual({
      tiers: ["fast"],
      why: "Groups your sessions, chats, mails and cards into topics and names them.",
    });
  });
});
