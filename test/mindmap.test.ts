import { expect, test } from "bun:test";
import { type Ask, type LlmFailCode, UNSUPPORTED_TEXT } from "../llm";
import { type MapAnswer, MindMap, SESSIONS_EVERY_MS } from "../mindmap";
import type { FactSession } from "../types";
import { type FakeOptions, fakeApi, groupingCalls, model, refusing, session } from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const MINUTE = 60_000;

function sessions(): FactSession[] {
  return [
    session({
      title: "Checkout redesign",
      cwd: "/home/ada/src/shop.worktrees/shop-12",
      state: "working",
    }),
    session({ title: "Refund bug", cwd: "/home/ada/src/shop", state: "waiting" }),
    session({ title: "Tax report", cwd: "/home/ada/src/books", state: "error" }),
    session({ title: "untitled", cwd: "/tmp", state: "ended" }),
    session({ title: "# The agent's report\n\nstatus: done", cwd: "/tmp", state: "ended" }),
    session({
      title: "THIS SESSION WORKS IN: x",
      cwd: "C:\\Users\\ada\\AppData\\Local\\prifly\\host\\summariser",
      state: "ended",
    }),
  ];
}

/** The first view starts the call; once it is done, the next one answers. */
async function settled(map: MindMap, now: number): Promise<MapAnswer> {
  map.view(now);
  await map.settle();
  return map.view(now + 1000);
}

function goodMap(answer: MapAnswer) {
  if (answer.state !== "map") throw new Error(`expected a map, got ${JSON.stringify(answer)}`);
  return answer;
}

function failure(answer: MapAnswer) {
  if (answer.state !== "error") throw new Error(`expected an error, got ${answer.state}`);
  return answer.error;
}

function setup(options: FakeOptions = {}, ask: Ask = model().ask) {
  const given = { sessions: sessions(), ask, ...options };
  const api = fakeApi(given);
  return { api, options: given, map: new MindMap(api) };
}

/** A restart: a new map on the same `api.state`, after the saves have landed. */
async function restarted(api: ReturnType<typeof fakeApi>) {
  await new Promise((done) => setTimeout(done, 0));
  const map = new MindMap(api);
  await map.load();
  return map;
}

const CODES: LlmFailCode[] = ["no-model", "not-allowed", "capped", "failed"];

test("sessions only: leftovers dropped, topic and summary lines from the model, the footer names the model", async () => {
  const { api, map } = setup();
  const answer = goodMap(await settled(map, NOW));
  const view = answer.map;
  expect(answer.current).toBe(true);
  expect(answer.error).toBeNull();
  expect(view.nodes.map((n) => n.title).sort()).toEqual([
    "Checkout redesign",
    "Refund bug",
    "Tax report",
  ]);
  expect(view.themes.map((t) => t.name)).toEqual(["Shop work"]);
  expect(view.nodes.every((n) => n.lines.join("|") === "line one|line two")).toBe(true);
  expect(view.nodes.find((n) => n.title === "Refund bug")?.status).toBe("waiting");
  // No solid links without session facts, and no entity shared by two sessions.
  expect(view.links).toEqual([]);
  expect(api.reads).toEqual([]);
  expect(view.footer.skipped).toEqual([]);
  expect(view.footer.model).toBe("Topics by claude-haiku via Claude");
});

test("an archived session is left out and does not count towards the cap; an unarchived one stays", async () => {
  const shape = { cwd: "/home/ada/src/shop", state: "working" as const };
  const titles = async (list: FactSession[]) =>
    goodMap(await settled(setup({ sessions: list }).map, NOW))
      .map.nodes.map((n) => n.title)
      .sort();
  const live = [
    session({ ...shape, title: "Kept plain" }),
    session({ ...shape, title: "Kept explicit", archived: false }),
    session({ ...shape, title: "Archived one", archived: true }),
  ];
  expect(await titles(live)).toEqual(["Kept explicit", "Kept plain"]);

  // 40 archived ones ahead of a kept one: the kept one still fits under the cap.
  const many = Array.from({ length: 40 }, (_, i) =>
    session({ ...shape, title: `Old ${i}`, archived: true }),
  );
  expect(await titles([...many, session({ ...shape, title: "Last kept" })])).toEqual(["Last kept"]);
});

test("a new session shows once the model has grouped it, not at the next read of sessions", async () => {
  const { options, map } = setup();
  goodMap(await settled(map, NOW));
  options.sessions.push(
    session({ title: "Brand new", cwd: "/home/ada/src/shop", state: "starting" }),
  );
  const has = (answer: MapAnswer) => goodMap(answer).map.nodes.some((n) => n.title === "Brand new");
  expect(has(map.view(NOW + 2000))).toBe(false);
  // Read within 15 s, but the model is asked only once a minute: the last good map stays.
  const waiting = goodMap(map.view(NOW + SESSIONS_EVERY_MS));
  expect(has(waiting)).toBe(false);
  expect(waiting.current).toBe(false);
  expect(waiting.error).toBeNull();
  expect(has(await settled(map, NOW + MINUTE + 1000))).toBe(true);
});

test("with read tools: a conversation joins, a failing source is named in the footer", async () => {
  const { map } = setup({
    features: ["state", "read-tools", "llm-ask"],
    read: async (name) => {
      if (name === "whatsapp_chats")
        return "- **Ada** `a1` · 2026-11-02 11:00 UTC\n  About the refund";
      throw new Error("not installed");
    },
  });
  const view = goodMap(await settled(map, NOW)).map;
  const chat = view.nodes.find((n) => n.kind === "conversation");
  expect(chat).toMatchObject({ title: "Ada", service: "WhatsApp" });
  expect(view.footer.skipped).toContain("Gmail (not installed)");
  expect(view.legend.services.map((s) => s.name)).toEqual(["WhatsApp"]);
});

test("one call groups and names everything; the same view twice keeps every position and asks nothing", async () => {
  const fake = model();
  const { map } = setup({}, fake.ask);
  const one = goodMap(await settled(map, NOW)).map;
  expect(groupingCalls(fake.calls)).toHaveLength(1);
  expect(fake.calls[0]).toMatchObject({ tier: "fast" });
  expect(fake.calls[0]?.schema).toBeDefined();
  const two = goodMap(map.view(NOW + 3000)).map;
  expect(two.nodes).toEqual(one.nodes);
  await map.settle();
  expect(groupingCalls(fake.calls)).toHaveLength(1);
});

test("an unchanged map is not asked about again, even after a minute", async () => {
  const fake = model();
  const { map } = setup({}, fake.ask);
  goodMap(await settled(map, NOW));
  goodMap(await settled(map, NOW + 5 * MINUTE));
  expect(groupingCalls(fake.calls)).toHaveLength(1);
});

test("feature absent: the error page says to update prifly, and nothing is asked", async () => {
  const fake = model();
  const { map } = setup({ features: ["state"], ask: fake.ask });
  const answer = map.view(NOW);
  expect(answer.state).toBe("error");
  expect(failure(answer)).toMatchObject({ code: "unsupported", text: UNSUPPORTED_TEXT });
  expect(UNSUPPORTED_TEXT).toBe("This prifly cannot lend the map a model yet: update prifly.");
  await map.settle();
  expect(fake.calls).toHaveLength(0);
});

test("feature absent after a good map: the last good map stays with the message in the footer", async () => {
  const { options, map } = setup();
  const before = goodMap(await settled(map, NOW));
  options.features = ["state"];
  options.sessions.push(session({ title: "Brand new", cwd: "/home/ada/src/books" }));
  map.view(NOW + 20_000);
  const kept = goodMap(await settled(map, NOW + MINUTE));
  expect(kept.current).toBe(false);
  expect(kept.map).toEqual(before.map);
  expect(kept.error?.text).toBe(UNSUPPORTED_TEXT);
});

for (const code of CODES) {
  test(`first load, answer ${code}: an error state with prifly's reason, nothing grouped`, async () => {
    const reason = `The reason for ${code}.`;
    const { map } = setup({ ask: refusing(code, reason) });
    expect(map.view(NOW)).toEqual({ state: "waiting" });
    await map.settle();
    const answer = map.view(NOW + 1000);
    expect(answer.state).toBe("error");
    expect(failure(answer)).toMatchObject({ code, text: reason });
  });

  test(`after a good map, answer ${code}: the last good map, the reason and its time; a later success makes a new map`, async () => {
    let down: Ask | null = null;
    const fake = model();
    const ask: Ask = (request) => (down ?? fake.ask)(request);
    const { options, map } = setup({}, ask);
    const before = goodMap(await settled(map, NOW));
    expect(before.updatedAt).toBe(NOW + 1000);

    down = refusing(code, `Down: ${code}.`);
    options.sessions.push(session({ title: "Brand new", cwd: "/home/ada/src/books" }));
    map.view(NOW + 20_000); // reads the new session
    const kept = goodMap(await settled(map, NOW + MINUTE));
    expect(kept.current).toBe(false);
    expect(kept.map).toEqual(before.map);
    expect(kept.updatedAt).toBe(NOW + 1000);
    expect(kept.error).toMatchObject({ code, text: `Down: ${code}.` });

    down = null;
    const recovered = goodMap(await settled(map, NOW + 2 * MINUTE));
    expect(recovered.current).toBe(true);
    expect(recovered.error).toBeNull();
    expect(recovered.map.nodes.map((n) => n.title)).toContain("Brand new");
  });
}

test("first load refused: asked again once a minute, and the map appears when the model does", async () => {
  let down = true;
  const fake = model();
  let calls = 0;
  const ask: Ask = async (request) => {
    calls += 1;
    return down ? { ok: false, code: "no-model", reason: "No model is set." } : fake.ask(request);
  };
  const { map } = setup({}, ask);
  failure(await settled(map, NOW));
  down = false;
  // Not before the minute is up.
  failure(await settled(map, NOW + MINUTE - 2000));
  expect(calls).toBe(1);
  const answer = goodMap(await settled(map, NOW + MINUTE));
  expect(answer.current).toBe(true);
  expect(answer.map.nodes).toHaveLength(3);
});

test("a call that throws is a failed answer, not a crash", async () => {
  const ask: Ask = async () => {
    throw new Error("socket closed");
  };
  const { map } = setup({}, ask);
  expect(failure(await settled(map, NOW))).toMatchObject({ code: "failed" });
});

test("a restart shows the last good map with its time, and asks nothing for the same items", async () => {
  const fake = model();
  const { api, map } = setup({}, fake.ask);
  const before = goodMap(await settled(map, NOW));

  const next = await restarted(api);
  const shown = goodMap(next.view(NOW + 5 * MINUTE));
  const places = (nodes: { id: string; theme: string; lines: string[] }[]) =>
    nodes.map(({ id, theme, lines }) => ({ id, theme, lines }));
  expect(places(shown.map.nodes)).toEqual(places(before.map.nodes));
  expect(shown.current).toBe(true);
  await next.settle();
  expect(groupingCalls(fake.calls)).toHaveLength(1);
});

test("a restart with the model gone shows the last good map and why", async () => {
  const { api, options, map } = setup();
  const before = goodMap(await settled(map, NOW));

  options.features = ["state"];
  options.sessions.push(session({ title: "Brand new", cwd: "/home/ada/src/books" }));
  const next = await restarted(api);
  const shown = goodMap(next.view(NOW + 5 * MINUTE));
  expect(shown.current).toBe(false);
  expect(shown.updatedAt).toBe(before.updatedAt);
  expect(shown.map.themes).toEqual(before.map.themes);
  expect(shown.error?.text).toBe(UNSUPPORTED_TEXT);
});

test("a Gmail circle carries the thread's link, which the panel opens on a click", async () => {
  const { map } = setup({
    features: ["state", "read-tools", "llm-ask"],
    read: async (name) => {
      if (name === "gmail_search")
        return "t-old | 3 msgs | Mon, 01 Jun 2026 09:00:00 +0000 | Grace <grace@example.com> | Starred long ago";
      throw new Error("not installed");
    },
  });
  const view = goodMap(await settled(map, NOW)).map;
  expect(view.nodes.find((n) => n.kind === "conversation")).toMatchObject({
    service: "Gmail",
    url: "https://mail.google.com/mail/u/0/#all/t-old",
  });
});
