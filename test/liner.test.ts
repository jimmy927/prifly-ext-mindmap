import { describe, expect, test } from "bun:test";
import { Grouper } from "../grouping";
import { AskLimits, LINES_BUDGET } from "../limits";
import { FAIL_GAP_MS, Liner } from "../liner";
import {
  BATCH,
  MAX_TOKENS as LINES_MAX_TOKENS,
  LINES_SCHEMA,
  lineFingerprint,
  linesRequest,
} from "../lines";
import type { Ask, LlmRequest } from "../llm";
import { MindMap } from "../mindmap";
import { ANSWER_SCHEMA, groupingRequest } from "../sorting";
import type { Item } from "../types";
import {
  fakeApi,
  fakeState,
  goodText,
  isLines,
  item,
  lineCalls,
  linesText,
  model,
  sentIn,
  session,
} from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");

/** `count` invented items shaped like the reader's: mostly sessions, then chats and mails, then cards. */
function invented(count: number): Item[] {
  return Array.from({ length: count }, (_, i): Item => {
    const id = `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    if (i % 5 === 3)
      return item({
        id: `c:gmail_search:${i}`,
        kind: "conversation",
        title: `Ada Lovelace ${i}`,
        name: `Ada Lovelace ${i}`,
        subject: `Refund for order ${1000 + i} that never arrived`,
        repo: "Gmail",
        head: `Hello, I wrote last week about order ${1000 + i} and nobody has answered yet, could you look at it today please? `.repeat(
          2,
        ),
      });
    if (i % 5 === 4)
      return item({
        id: `k:card${i}`,
        kind: "card",
        title: `SHOP-${i} fix the checkout page`,
        repo: "Trello",
      });
    return item({
      id,
      title: `Checkout redesign for the shop number ${i}`,
      repo: "shop-frontend",
      brief: [
        `Blocked on the sandbox keys ${i}`,
        `Next: write the refund tests ${i}`,
        "Done: the cart page",
      ],
    });
  });
}

const sentItems = (request: LlmRequest) => sentIn(request).items.length;

function liner(ask: Ask, limits = new AskLimits()) {
  const state = fakeState();
  return { liner: new Liner({ ask: () => ask, limits, state }), state, limits };
}

describe("the size of the calls", () => {
  const items = invented(75);
  const request = groupingRequest(items, { shared: [], previous: [] });

  test("the grouping prompt for 75 items stays small, and asks for no summary lines", () => {
    expect(items).toHaveLength(75);
    // About 3.5k tokens of input; invented items here are on the long side (long titles, two brief lines, 120-char heads).
    expect(request.prompt.length).toBeLessThan(14_000);
    expect(request.system.length).toBeLessThan(4_000);
    expect(JSON.stringify(ANSWER_SCHEMA)).not.toContain("lines");
    expect(request.system).not.toContain("summary lines of at most");
    const sent = sentIn(request);
    expect(sent.items.map((i) => i.id).slice(0, 3)).toEqual(["i1", "i2", "i3"]);
    expect(sent.items.every((i) => i["lines"] === undefined)).toBe(true);
  });

  test("a line batch for 20 items is small too, and asks only for lines", () => {
    const batch = linesRequest(items.slice(0, BATCH));
    expect(sentItems(batch)).toBe(20);
    expect(batch.prompt.length).toBeLessThan(8_000);
    expect(batch.schema).toBe(LINES_SCHEMA);
    expect(JSON.stringify(LINES_SCHEMA)).not.toContain("topics");
    expect(batch.tier).toBe("fast");
  });

  test("a line batch leaves room for the model's thinking: at 2,500 tokens a 20-item answer never came back", () => {
    const batch = linesRequest(items.slice(0, BATCH));
    expect(batch.maxTokens).toBe(LINES_MAX_TOKENS);
    expect(LINES_MAX_TOKENS).toBeGreaterThanOrEqual(32_000);
  });
});

describe("the line batches", () => {
  test("batches hold at most 20 items, one after another, and 75 items take 4", async () => {
    const items = invented(75);
    let flying = 0;
    let mostFlying = 0;
    const sizes: number[] = [];
    const ask: Ask = async (request) => {
      flying += 1;
      mostFlying = Math.max(mostFlying, flying);
      sizes.push(sentItems(request));
      await new Promise((done) => setTimeout(done, 1));
      flying -= 1;
      return { ok: true, text: linesText(request), model: "m", backend: "claude" };
    };
    const { liner: made } = liner(ask);
    // Several ticks at once and in turn: still one ask at a time, one batch a tick.
    await Promise.all([made.update(items, NOW), made.update(items, NOW)]);
    expect(sizes).toEqual([20]);
    for (let tick = 1; tick < 6; tick += 1) await made.update(items, NOW + tick * 5000);
    expect(sizes).toEqual([20, 20, 20, 15]);
    expect(mostFlying).toBe(1);
    expect(made.pending(items)).toEqual([]);
  });

  test("items with kept lines are skipped; a changed item is asked for again, alone", async () => {
    const items = invented(10);
    const calls: LlmRequest[] = [];
    const ask: Ask = async (request) => {
      calls.push(request);
      return { ok: true, text: linesText(request), model: "m", backend: "claude" };
    };
    const { liner: made, state } = liner(ask);
    await made.update(items, NOW);
    expect(calls).toHaveLength(1);
    await made.update(items, NOW + 5000);
    expect(calls).toHaveLength(1);

    // A restart on the same state asks for nothing either.
    const again = new Liner({ ask: () => ask, limits: new AskLimits(), state });
    await again.load();
    await again.update(items, NOW + 10_000);
    expect(calls).toHaveLength(1);
    expect(Object.keys(again.linesOf(items))).toHaveLength(10);

    const changed = items.map((it, i) => (i === 2 ? { ...it, title: "A new title for it" } : it));
    expect(again.pending(changed).map((it) => it.id)).toEqual([items[2]?.id ?? "-"]);
    // The old lines stay until the new ones come.
    expect(again.linesOf(changed)[items[2]?.id ?? "-"]).toEqual(["line one", "line two"]);
    await again.update(changed, NOW + 15_000);
    expect(calls).toHaveLength(2);
    expect(sentItems(calls[1] ?? ({} as LlmRequest))).toBe(1);
    // What moves an item's order, status or place does not change its fingerprint.
    const moved = { ...items[0], status: "error" } as Item;
    expect(lineFingerprint(moved)).toBe(lineFingerprint(items[0] as Item));
  });

  test("lines that repeat the title are left out; at most two, cut to fit", async () => {
    const items = [
      item({ id: "a", title: "Linux install" }),
      item({ id: "b", title: "Refund bug" }),
    ];
    const ask: Ask = async () => ({
      ok: true,
      model: "m",
      backend: "claude",
      text: JSON.stringify({
        items: [
          { id: "i1", lines: ["Linux install", "needs a USB stick to boot from"] },
          { id: "i2", lines: ["Customer waits", "money back", "a third one"] },
        ],
      }),
    });
    const { liner: made } = liner(ask);
    await made.update(items, NOW);
    expect(made.linesOf(items)["a"]).toEqual(["needs a USB stick to…"]);
    expect(made.linesOf(items)["b"]).toEqual(["Customer waits", "money back"]);
  });

  test("a failed batch stops the batches for a minute, and an unreadable answer counts as failed", async () => {
    const items = invented(45);
    let n = 0;
    let mode: "refuse" | "junk" | "ok" = "refuse";
    const ask: Ask = async (request) => {
      n += 1;
      if (mode === "refuse") return { ok: false, code: "failed", reason: "It failed." };
      const text = mode === "junk" ? "I cannot do that" : linesText(request);
      return { ok: true, text, model: "m", backend: "claude" };
    };
    const { liner: made } = liner(ask);
    await made.update(items, NOW);
    await made.update(items, NOW + 5000);
    expect(n).toBe(1);
    mode = "junk";
    await made.update(items, NOW + FAIL_GAP_MS);
    await made.update(items, NOW + FAIL_GAP_MS + 5000);
    expect(n).toBe(2);
    expect(made.linesOf(items)).toEqual({});
    mode = "ok";
    await made.update(items, NOW + 2 * FAIL_GAP_MS);
    expect(n).toBe(3);
    expect(Object.keys(made.linesOf(items))).toHaveLength(BATCH);
  });

  test("a call that throws is a failed batch, not a crash", async () => {
    const ask: Ask = async () => {
      throw new Error("socket closed");
    };
    const { liner: made, limits } = liner(ask);
    await made.update(invented(3), NOW);
    expect(made.linesOf(invented(3))).toEqual({});
    expect(limits.busy).toBe(false);
  });

  test("the hour's count has a margin: no batch once the asks of the hour reach the budget", async () => {
    const limits = new AskLimits();
    for (let i = 0; i < LINES_BUDGET; i += 1) limits.record(NOW - 1000);
    let n = 0;
    const ask: Ask = async (request) => {
      n += 1;
      return { ok: true, text: linesText(request), model: "m", backend: "claude" };
    };
    const { liner: made } = liner(ask, limits);
    await made.update(invented(5), NOW);
    expect(n).toBe(0);
    // An hour on, the asks are forgotten.
    await made.update(invented(5), NOW + 3_700_000);
    expect(n).toBe(1);
  });

  test("not while the grouping is in flight", async () => {
    const limits = new AskLimits();
    let release: () => void = () => undefined;
    const slow: Ask = async (request) => {
      await new Promise<void>((done) => {
        release = done;
      });
      return { ok: true, text: goodText(request), model: "m", backend: "claude" };
    };
    const lines = model();
    const group = new Grouper({ ask: () => slow, limits });
    const items = invented(6);
    const grouping = group.update({ items, entities: new Map(), shared: [] }, NOW);
    await new Promise((done) => setTimeout(done, 0));
    const { liner: made } = liner(lines.ask, limits);
    await made.update(items, NOW + 1000);
    expect(lines.calls).toHaveLength(0);
    release();
    await grouping;
    await made.update(items, NOW + 2000);
    expect(lines.calls).toHaveLength(1);
  });
});

describe("the map and the lines", () => {
  const sessions = () => [
    session({ title: "Checkout redesign", cwd: "/home/ada/src/shop", state: "working" }),
    session({ title: "Refund bug", cwd: "/home/ada/src/shop", state: "waiting" }),
    session({ title: "Tax report", cwd: "/home/ada/src/books", state: "error" }),
  ];

  test("the map is drawn after the grouping call alone, with no lines under the circles", async () => {
    const fake = model((request) => (isLines(request) ? "" : goodText(request)));
    let hold = true;
    const ask: Ask = async (request) => {
      // The lines never answer in this test: the map must not wait for them.
      if (isLines(request) && hold) return new Promise<never>(() => undefined);
      return fake.ask(request);
    };
    const map = new MindMap(fakeApi({ sessions: sessions(), ask }));
    map.view(NOW);
    // Wait for the grouping call, not for the refresh (which is stuck on the lines).
    for (let i = 0; i < 50 && fake.calls.length === 0; i += 1)
      await new Promise((done) => setTimeout(done, 1));
    await new Promise((done) => setTimeout(done, 5));
    const answer = map.view(NOW + 1000);
    hold = false;
    if (answer.state !== "map") throw new Error(`expected a map, got ${answer.state}`);
    expect(answer.current).toBe(true);
    expect(answer.map.nodes).toHaveLength(3);
    expect(answer.map.nodes.every((n) => n.lines.length === 0)).toBe(true);
    expect(fake.calls.filter((r) => !isLines(r))).toHaveLength(1);
  });

  test("a failed batch stops the others that tick, and the map still shows", async () => {
    const calls: LlmRequest[] = [];
    const ask: Ask = async (request) => {
      calls.push(request);
      return isLines(request)
        ? { ok: false, code: "failed", reason: "It failed." }
        : { ok: true, text: goodText(request), model: "claude-haiku", backend: "claude" };
    };
    const map = new MindMap(fakeApi({ sessions: sessions(), ask }));
    map.view(NOW);
    await map.settle();
    const answer = map.view(NOW + 1000);
    await map.settle();
    map.view(NOW + 6000);
    await map.settle();
    if (answer.state !== "map") throw new Error(`expected a map, got ${answer.state}`);
    expect(answer.error).toBeNull();
    expect(answer.map.nodes).toHaveLength(3);
    expect(answer.map.nodes.every((n) => n.lines.length === 0)).toBe(true);
    // One grouping, one failed batch; nothing more inside the minute.
    expect(calls.filter((r) => !isLines(r))).toHaveLength(1);
    expect(lineCalls(calls)).toHaveLength(1);
  });

  test("first load of 40 sessions: one grouping call, then a batch of 20 on each tick, and the lines appear", async () => {
    const sess = Array.from({ length: 40 }, (_, i) =>
      session({ title: `Job ${i} for the shop`, cwd: "/home/ada/src/shop", state: "idle" }),
    );
    const fake = model();
    const map = new MindMap(fakeApi({ sessions: sess, ask: fake.ask }));
    for (let tick = 0; tick < 4; tick += 1) {
      map.view(NOW + tick * 5000);
      await map.settle();
    }
    expect(fake.calls.filter((r) => !isLines(r))).toHaveLength(1);
    expect(lineCalls(fake.calls).map(sentItems)).toEqual([20, 20]);
    const last = map.view(NOW + 20_000);
    if (last.state !== "map") throw new Error("expected a map");
    expect(last.map.nodes.every((n) => n.lines.join("|") === "line one|line two")).toBe(true);
    // Nothing more once all the lines are made.
    map.view(NOW + 25_000);
    await map.settle();
    expect(fake.calls).toHaveLength(3);
  });
});
