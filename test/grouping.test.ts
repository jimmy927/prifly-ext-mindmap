import { describe, expect, test } from "bun:test";
import { Grouper, KEEP_NAME, MIN_GAP_MS } from "../grouping";
import type { Ask, LlmRequest } from "../llm";
import { lineProblem, nameProblem } from "../rules";
import { ANSWER_SCHEMA, groupingRequest, parseGrouping } from "../sorting";
import type { Picked } from "../topics";
import type { Item } from "../types";
import { fakeState, item, model, type Sent, sentIn } from "./fake";

const A = "aaaaaaaa-1111-4000-8000-000000000000";
const B = "bbbbbbbb-2222-4000-8000-000000000000";
const C = "cccccccc-3333-4000-8000-000000000000";

const items = (): Item[] => [
  item({ id: A, title: "Linux install", repo: "laptop" }),
  item({ id: B, title: "Refund bug", repo: "shop" }),
];

const picked = (list = items()): Picked => ({ items: list, entities: new Map(), shared: [] });

type Answer = {
  topics?: { id: string; name: string; sub?: string }[];
  items?: { id: string; topic: string }[];
  related?: { a: string; b: string; label: string }[];
};

/** A model's answer for `items()`: two topics by default. */
function answer(parts: Answer = {}): string {
  return JSON.stringify({
    topics: (
      parts.topics ?? [
        { id: "t1", name: "Laptop setup" },
        { id: "t2", name: "Shop refunds" },
      ]
    ).map((t) => ({ sub: "sub", ...t })),
    items: parts.items ?? [
      { id: "i1", topic: "t1" },
      { id: "i2", topic: "t2" },
    ],
    related: parts.related ?? [],
  });
}

/** A Grouper over a model that gives these answers in turn (the last one again after that). */
function grouper(texts: string[], list = items()) {
  const fake = model((_request, call) => texts[Math.min(call, texts.length) - 1] ?? "");
  const state = fakeState();
  const group = new Grouper({ ask: () => fake.ask, state });
  return { group, calls: fake.calls, state, list, picked: picked(list) };
}

describe("reading the answer", () => {
  test("a good answer gives topics, each item's topic, and related pairs; no lines", () => {
    const text = answer({
      related: [
        { a: "i1", b: "i2", label: "A very long label for two items" },
        { a: "i1", b: "i9", label: "unknown item" },
        { a: "i2", b: "i2", label: "itself" },
      ],
    });
    const { grouping, problems } = parseGrouping(text, items());
    expect(problems).toEqual([]);
    expect(grouping?.topics.map((t) => t.name)).toEqual(["Laptop setup", "Shop refunds"]);
    expect(grouping?.topicOf.get(A)).toBe("t1");
    expect(grouping?.topicOf.get(B)).toBe("t2");
    expect(grouping).not.toHaveProperty("lines");
    expect(grouping?.related).toEqual([{ a: A, b: B, label: "A very long…" }]);
  });

  test("JSON in a fence or after a sentence is read; a topic with no item is dropped", () => {
    const text = `Here you go:\n\`\`\`json\n${answer({
      topics: [
        { id: "t1", name: "Everything" },
        { id: "t2", name: "Empty" },
      ],
      items: [
        { id: "i1", topic: "t1" },
        { id: "i2", topic: "t1" },
      ],
    })}\n\`\`\``;
    const { grouping } = parseGrouping(text, items());
    expect(grouping?.topics.map((t) => t.id)).toEqual(["t1"]);
  });

  test("an answer that is no grouping says why", () => {
    const why = (text: string) => parseGrouping(text, items()).problems.join(" | ");
    expect(why("I cannot do that")).toContain("not the JSON asked for");
    expect(why(JSON.stringify({ topics: [] }))).toContain("not the JSON asked for");
    expect(why(answer({ items: [{ id: "i1", topic: "t1" }] }))).toContain(
      "items without a topic: i2",
    );
    expect(
      why(
        answer({
          items: [
            { id: "i1", topic: "t1" },
            { id: "i2", topic: "t7" },
          ],
        }),
      ),
    ).toContain('"t7", which is not in topics');
    expect(
      why(
        answer({
          topics: [
            { id: "t1", name: "WhatsApp" },
            { id: "t2", name: "Shop" },
          ],
        }),
      ),
    ).toContain("is a service");
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, name: `Subject ${i}` }));
    expect(why(answer({ topics: ten }))).toContain("more than 9 topics");
  });

  test("the schema sent with the call is the shape that is read", () => {
    expect(ANSWER_SCHEMA["type"]).toBe("object");
    expect(ANSWER_SCHEMA["$schema"]).toBeUndefined();
    expect(Object.keys(ANSWER_SCHEMA["properties"] as object)).toEqual([
      "topics",
      "items",
      "related",
    ]);
    expect(ANSWER_SCHEMA["required"]).toEqual(["topics", "items", "related"]);
    // The grouping asks for no summary lines: they are asked for in batches.
    expect(JSON.stringify(ANSWER_SCHEMA)).not.toContain("lines");
  });
});

describe("the request", () => {
  const shared = [{ a: A, b: B, label: "Ada" }];
  const previous = [{ id: "t1", name: "Laptop setup", sub: "dual boot", members: [A, "gone"] }];
  const request = groupingRequest(items(), { shared, previous });

  test("asks the fast tier with a schema, and sends the items with the hints, by short ids", () => {
    expect(request).toMatchObject({ tier: "fast", schema: ANSWER_SCHEMA });
    const sent: Sent = sentIn(request);
    expect(sent.items.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(sent.items[0]).toMatchObject({
      kind: "session",
      title: "Linux install",
      repo: "laptop",
    });
    expect(sent.sharedEntities).toEqual([{ a: "i1", b: "i2", label: "Ada" }]);
    expect(sent.previousTopics).toEqual([
      { id: "t1", name: "Laptop setup", sub: "dual boot", members: ["i1"] },
    ]);
  });

  test("a conversation is sent with its name, subject and the first 120 characters of its last message", () => {
    const chat = item({
      id: "c:gmail_search:1",
      kind: "conversation",
      title: "Ada",
      name: "Ada Lovelace",
      repo: "Gmail",
      subject: "Refund",
      head: "x".repeat(300),
      brief: ["a", "b", "c", "d", "e"],
    });
    const sent = sentIn(groupingRequest([chat], { shared: [], previous: [] }));
    expect(sent.items[0]).toMatchObject({
      kind: "chat or mail",
      name: "Ada Lovelace",
      subject: "Refund",
      brief: ["a", "b"],
    });
    expect(String(sent.items[0]?.["last"])).toBe("x".repeat(120));
  });

  test("the system prompt carries the naming rules", () => {
    expect(request.system).toContain("Personal and Work");
    expect(request.system).toContain("must not share its main word");
    expect(request.system).toContain("previousTopics");
  });
});

describe("the grouper", () => {
  test("a good answer takes one call and is kept in api.state", async () => {
    const { group, calls, state, picked } = grouper([answer()]);
    await group.update(picked, 0);
    expect(calls).toHaveLength(1);
    const kept = group.answerFor(picked.items);
    expect(kept?.topics.map((t) => t.name)).toEqual(["Laptop setup", "Shop refunds"]);
    expect(kept).toMatchObject({ model: "claude-haiku", backend: "claude" });
    expect(group.error()).toBeNull();
    expect(state.docs.get("grouping")).toMatchObject({ model: "claude-haiku" });
  });

  test("an answer that misses an item is asked again, and the second one is kept", async () => {
    const { group, calls, picked } = grouper([
      answer({ items: [{ id: "i1", topic: "t1" }] }),
      answer(),
    ]);
    await group.update(picked, 0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("items without a topic: i2");
    expect(group.answerFor(picked.items)).not.toBeNull();
  });

  test("a bad answer twice is no answer: a failure naming why, after exactly two calls", async () => {
    const { group, calls, picked } = grouper(["nonsense"]);
    await group.update(picked, 0);
    expect(calls).toHaveLength(2);
    expect(group.answerFor(picked.items)).toBeNull();
    expect(group.error()).toMatchObject({ code: "bad-answer" });
  });

  test("the retry refused: a first answer of the right shape stands", async () => {
    const mixed = answer({
      topics: [
        { id: "t1", name: "Shop refunds" },
        { id: "t2", name: "Refunds again" },
      ],
    });
    let n = 0;
    const calls: LlmRequest[] = [];
    const ask: Ask = async (request) => {
      calls.push(request);
      n += 1;
      return n === 1
        ? { ok: true, text: mixed, model: "m", backend: "codex" }
        : { ok: false, code: "capped", reason: "Limit reached." };
    };
    const group = new Grouper({ ask: () => ask });
    await group.update(picked(), 0);
    expect(calls).toHaveLength(2);
    expect(group.answerFor(items())?.topics).toHaveLength(2);
    expect(group.error()).toBeNull();
  });
});

describe("the grouper and the naming rules", () => {
  test("a catch-all name is retried once; with no earlier name the answer fails", async () => {
    const mixed = answer({
      topics: [
        { id: "t1", name: "Mixed" },
        { id: "t2", name: "Shop refunds" },
      ],
    });
    const { group, calls, picked } = grouper([mixed]);
    await group.update(picked, 0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("catch-all");
    expect(group.answerFor(picked.items)).toBeNull();
    expect(group.error()).toMatchObject({ code: "bad-answer" });
  });

  test("an overlap that stays after the retry is kept, with no earlier name", async () => {
    const clash = answer({
      topics: [
        { id: "t1", name: "Shop refunds" },
        { id: "t2", name: "Refunds again" },
      ],
    });
    const { group, calls, picked } = grouper([clash]);
    await group.update(picked, 0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('shares "refunds"');
    expect(group.answerFor(picked.items)?.topics.map((t) => t.name)).toEqual([
      "Shop refunds",
      "Refunds again",
    ]);
  });

  test("hints on the next call: the previous topics with their members, and the shared-entity pairs", async () => {
    const three = answer({
      items: [
        { id: "i1", topic: "t1" },
        { id: "i2", topic: "t2" },
        { id: "i3", topic: "t2" },
      ],
    });
    const { group, calls, picked } = grouper([answer(), three]);
    await group.update(picked, 0);
    const more = [...picked.items, item({ id: C, title: "Tax report", repo: "books" })];
    const next: Picked = {
      items: more,
      entities: new Map(),
      shared: [{ a: B, b: C, label: "Ada" }],
    };
    await group.update(next, MIN_GAP_MS);
    expect(calls).toHaveLength(2);
    const sent = sentIn(calls[1] ?? ({} as LlmRequest));
    expect(sent.sharedEntities).toEqual([{ a: "i2", b: "i3", label: "Ada" }]);
    expect(sent.previousTopics).toEqual([
      { id: "t1", name: "Laptop setup", sub: "sub", members: ["i1"] },
      { id: "t2", name: "Shop refunds", sub: "sub", members: ["i2"] },
    ]);
  });

  test("a topic keeps its name while its members barely change, whatever the model now calls it", async () => {
    expect(KEEP_NAME).toBe(0.5);
    const four = ["a", "b", "c", "d"].map((x, i) =>
      item({
        id: `${x.repeat(8)}-0000-4000-8000-000000000000`,
        title: `Job ${i} ${x}`,
        repo: "shop",
      }),
    );
    const everything = (name: string) =>
      JSON.stringify({
        topics: [{ id: "t1", name, sub: "s" }],
        items: four.map((_, i) => ({ id: `i${i + 1}`, topic: "t1" })),
        related: [],
      });
    const { group, picked } = grouper([everything("Garden jobs"), everything("Yard work")], four);
    await group.update(picked, 0);
    const changed = four.map((i) => ({ ...i, title: `${i.title} again` }));
    await group.update({ items: changed, entities: new Map(), shared: [] }, MIN_GAP_MS);
    expect(group.answerFor(changed)?.topics[0]?.name).toBe("Garden jobs");
  });

  test("once a minute, failures included; and not again for items it has answered", async () => {
    let n = 0;
    const ask: Ask = async () => {
      n += 1;
      return { ok: false, code: "failed", reason: "It failed." };
    };
    const group = new Grouper({ ask: () => ask });
    await group.update(picked(), 0);
    await group.update(picked(), MIN_GAP_MS - 1);
    expect(n).toBe(1);
    await group.update(picked(), MIN_GAP_MS);
    expect(n).toBe(2);
  });

  test("a restart reads the kept answer and does not ask again", async () => {
    const one = grouper([answer()]);
    await one.group.update(one.picked, 0);
    await new Promise((done) => setTimeout(done, 0));
    const fake = model();
    const again = new Grouper({ ask: () => fake.ask, state: one.state });
    await again.load();
    expect(again.answerFor(one.picked.items)).not.toBeNull();
    await again.update(one.picked, 10 * MIN_GAP_MS);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the naming rules", () => {
  test("a theme name that shares its main word with another theme's is rejected", () => {
    expect(nameProblem("Prifly and ODI", ["Prifly Project"])?.kind).toBe("overlap");
    expect(nameProblem("ODI Support", ["Prifly and ODI"])?.kind).toBe("overlap");
    // Only filler in common is no overlap.
    expect(nameProblem("Tax Project", ["Garden Project"])).toBeNull();
    expect(nameProblem("Refund flow", ["Checkout redesign", "Linux install"])).toBeNull();
  });

  test("catch-all names are rejected", () => {
    for (const name of [
      "Digital Activity: Mixed",
      "Misc",
      "Other things",
      "General",
      "Personal and Work",
      "Various chats",
      "Övrigt",
    ])
      expect(nameProblem(name, [])?.kind).toBe("catch-all");
    expect(nameProblem("Family trip to Skåne", [])).toBeNull();
  });

  test("a line equal to, a prefix of, or inside the title is rejected, whatever its case or punctuation", () => {
    expect(lineProblem("Linux install", "Linux install")).not.toBeNull();
    expect(lineProblem("LINUX, install!", "Linux install")).not.toBeNull();
    expect(lineProblem("Linux…", "Linux install")).not.toBeNull();
    expect(lineProblem("install", "Linux install")).not.toBeNull();
    expect(lineProblem("Person contact", "Ada Lovelace")).not.toBeNull();
    expect(lineProblem("Message from Ada", "Ada Lovelace")).not.toBeNull();
    expect(lineProblem("Dual boot, needs a USB stick", "Linux install")).toBeNull();
  });
});
