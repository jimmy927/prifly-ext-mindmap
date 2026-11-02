import { expect, test } from "bun:test";
import { DeepInfraError, NO_KEY_TEXT } from "../deepinfra";
import type { Embed } from "../embed";
import { type MapAnswer, MindMap, type MindMapDeps, SESSIONS_EVERY_MS } from "../mindmap";
import type { Chat } from "../model";
import type { FactSession } from "../types";
import { type FakeOptions, fakeApi, session } from "./fake";

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

/** DeepInfra as it answers when well: every text a vector, every topic a name. */
function working(): { embed: Embed; chat: Chat; calls: { embed: number; chat: number } } {
  const calls = { embed: 0, chat: 0 };
  const embed: Embed = async (_key, _model, texts) => {
    calls.embed += 1;
    return texts.map(() => [1, 0, 0]);
  };
  const chat: Chat = async (_key, _model, messages) => {
    calls.chat += 1;
    const payload = JSON.parse(messages[1]?.content ?? "{}") as { items: { id: string }[] };
    return JSON.stringify({
      name: "Named topic",
      sub: "named by the model",
      items: payload.items.map((i) => ({ id: i.id, lines: ["line one", "line two"] })),
      pairs: [],
    });
  };
  return { embed, chat, calls };
}

/** The first view starts the calls; once they are done, the next one answers. */
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

function setup(options: FakeOptions = {}, deps: MindMapDeps = working()) {
  const given = { sessions: sessions(), key: "k", ...options };
  const api = fakeApi(given);
  return { api, options: given, map: new MindMap(api, deps) };
}

/** A restart: a new map on the same `api.state`, after the saves have landed. */
async function restarted(api: ReturnType<typeof fakeApi>, deps: MindMapDeps) {
  await new Promise((done) => setTimeout(done, 0));
  const map = new MindMap(api, deps);
  await map.load();
  return map;
}

test("sessions only: leftovers dropped, every theme and summary line from the model", async () => {
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
  expect(view.themes.map((t) => t.name)).toEqual(["Named topic"]);
  expect(view.nodes.every((n) => n.lines.join("|") === "line one|line two")).toBe(true);
  expect(view.nodes.find((n) => n.title === "Refund bug")?.status).toBe("waiting");
  // No solid links without session facts; the dashed ones are pairs only the embeddings tie.
  expect(view.links.every((link) => link.kind === "related")).toBe(true);
  expect(api.reads).toEqual([]);
  expect(view.footer.skipped).toEqual([]);
  expect(view.footer.model).toBe("Names by gemma-4-26B-A4B-it · similarity by embeddinggemma-300m");
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

test("a new session shows once it has its embedding and name, not at the next read of sessions", async () => {
  const { options, map } = setup();
  goodMap(await settled(map, NOW));
  options.sessions.push(
    session({ title: "Brand new", cwd: "/home/ada/src/shop", state: "starting" }),
  );
  const has = (answer: MapAnswer) => goodMap(answer).map.nodes.some((n) => n.title === "Brand new");
  expect(has(map.view(NOW + 2000))).toBe(false);
  // Read within 15 s, but DeepInfra is asked only once a minute: the last good map stays.
  const waiting = goodMap(map.view(NOW + SESSIONS_EVERY_MS));
  expect(has(waiting)).toBe(false);
  expect(waiting.current).toBe(false);
  expect(waiting.error).toBeNull();
  expect(has(await settled(map, NOW + MINUTE + 1000))).toBe(true);
});

test("with read tools: a conversation joins, a failing source is named in the footer", async () => {
  const { map } = setup({
    features: ["state", "read-tools"],
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

test("the model names each topic in one short call; the same view twice keeps every position", async () => {
  const deps = working();
  const { map } = setup({}, deps);
  const one = goodMap(await settled(map, NOW)).map;
  expect(deps.calls.chat).toBe(one.themes.length);
  expect(deps.calls.embed).toBe(1);
  const two = goodMap(map.view(NOW + 3000)).map;
  expect(two.nodes).toEqual(one.nodes);
});

test("first load with no key: an error state naming the missing key, and nothing is grouped or called", async () => {
  const deps = working();
  const { map } = setup({ key: null }, deps);
  expect(map.view(NOW)).toEqual({ state: "waiting" });
  await map.settle();
  const answer = map.view(NOW + 1000);
  expect(answer.state).toBe("error");
  expect(failure(answer)).toMatchObject({ call: "embedding", kind: "no-key", text: NO_KEY_TEXT });
  expect(NO_KEY_TEXT).toContain("an api-token entry named deepinfra or deepinfra-api, at level 1");
  expect(deps.calls).toEqual({ embed: 0, chat: 0 });
});

test("first load with no key: the extension tries again once a minute, and the map appears when the key does", async () => {
  const deps = working();
  const { options, map } = setup({ key: null }, deps);
  failure(await settled(map, NOW));
  options.key = "k";
  // Not before the minute is up.
  failure(await settled(map, NOW + MINUTE - 2000));
  expect(deps.calls).toEqual({ embed: 0, chat: 0 });
  const answer = goodMap(await settled(map, NOW + MINUTE));
  expect(answer.current).toBe(true);
  expect(answer.map.nodes).toHaveLength(3);
});

test("first load with a failing embedding call: an error state with DeepInfra's status, and no naming", async () => {
  const deps = working();
  const embed: Embed = async () => {
    throw new DeepInfraError(401, "Invalid API key");
  };
  const { map } = setup({}, { ...deps, embed });
  const answer = await settled(map, NOW);
  expect(answer.state).toBe("error");
  expect(failure(answer)).toMatchObject({
    call: "embedding",
    kind: "http",
    status: 401,
    title: "DeepInfra answered 401",
    text: "DeepInfra answered 401 to the embedding call: Invalid API key",
  });
  expect(deps.calls.chat).toBe(0);
});

test("first load with a failing naming call: an error state with DeepInfra's status", async () => {
  const deps = working();
  const chat: Chat = async () => {
    throw new DeepInfraError(429, "Rate limit reached");
  };
  const { map } = setup({}, { ...deps, chat });
  const answer = await settled(map, NOW);
  expect(answer.state).toBe("error");
  expect(failure(answer)).toMatchObject({
    call: "naming",
    kind: "http",
    status: 429,
    text: "DeepInfra answered 429 to the naming call: Rate limit reached",
  });
});

test("a failure with no HTTP status (a timeout) is an error state too, in the call's own words", async () => {
  const embed: Embed = async () => {
    throw new Error("The operation timed out.");
  };
  const { map } = setup({}, { ...working(), embed });
  expect(failure(await settled(map, NOW))).toMatchObject({
    kind: "other",
    status: null,
    text: "The embedding call to DeepInfra failed: The operation timed out.",
  });
});

test("after a good map, a failing embedding call keeps the last good map, the error and its time; a later success makes a new map", async () => {
  const deps = working();
  let down: DeepInfraError | null = null;
  const embed: Embed = async (key, model, texts) => {
    if (down !== null) throw down;
    return deps.embed(key, model, texts);
  };
  const { options, map } = setup({}, { ...deps, embed });
  const before = goodMap(await settled(map, NOW));
  expect(before.updatedAt).toBe(NOW + 1000);

  down = new DeepInfraError(503, "Service unavailable");
  options.sessions.push(session({ title: "Brand new", cwd: "/home/ada/src/books" }));
  map.view(NOW + 20_000); // reads the new session
  const kept = goodMap(await settled(map, NOW + MINUTE));
  expect(kept.current).toBe(false);
  expect(kept.map).toEqual(before.map);
  expect(kept.updatedAt).toBe(NOW + 1000);
  expect(kept.error).toMatchObject({ call: "embedding", status: 503 });

  // Still failing a minute later: still the same map.
  const again = goodMap(await settled(map, NOW + 2 * MINUTE));
  expect(again.map).toEqual(before.map);
  expect(again.error?.status).toBe(503);

  down = null;
  const recovered = goodMap(await settled(map, NOW + 3 * MINUTE));
  expect(recovered.current).toBe(true);
  expect(recovered.error).toBeNull();
  expect(recovered.updatedAt).toBe(NOW + 3 * MINUTE + 1000);
  expect(recovered.map.nodes.map((n) => n.title)).toContain("Brand new");
});

test("after a good map, a failing naming call keeps the last good map; the next good call replaces it", async () => {
  const deps = working();
  let down = false;
  const chat: Chat = async (key, model, messages) => {
    if (down) throw new DeepInfraError(500, "Internal error");
    return deps.chat(key, model, messages);
  };
  const { options, map } = setup({}, { ...deps, chat });
  const before = goodMap(await settled(map, NOW));

  down = true;
  options.sessions.push(session({ title: "Brand new", cwd: "/home/ada/src/books" }));
  map.view(NOW + 20_000);
  const kept = goodMap(await settled(map, NOW + MINUTE));
  expect(kept.current).toBe(false);
  expect(kept.map).toEqual(before.map);
  expect(kept.error).toMatchObject({ call: "naming", status: 500 });

  down = false;
  const recovered = goodMap(await settled(map, NOW + 2 * MINUTE));
  expect(recovered.current).toBe(true);
  expect(recovered.error).toBeNull();
  expect(recovered.map.nodes.map((n) => n.title)).toContain("Brand new");
});

test("a restart shows the last good map with its time, and the error when the key has gone", async () => {
  const deps = working();
  const { api, options, map } = setup({}, deps);
  const before = goodMap(await settled(map, NOW));

  options.key = null;
  options.sessions.push(session({ title: "Brand new", cwd: "/home/ada/src/books" }));
  const next = await restarted(api, deps);
  const shown = goodMap(next.view(NOW + 5 * MINUTE));
  expect(shown.current).toBe(false);
  expect(shown.updatedAt).toBe(before.updatedAt);
  expect(shown.map.nodes).toEqual(before.map.nodes);
  expect(shown.map.themes).toEqual(before.map.themes);
  await next.settle();
  expect(goodMap(next.view(NOW + 5 * MINUTE + 1000)).error).toMatchObject({
    kind: "no-key",
    text: NO_KEY_TEXT,
  });
});

const EMBED_MODEL = "google/embeddinggemma-300m";

/** Two groups of sessions the embeddings tell apart: "alpha" ones along x, "beta" ones along y. */
function twoGroups(): { options: FakeOptions; ids: Record<string, string>; deps: MindMapDeps } {
  const shop = "/home/ada/src/shop";
  const books = "/home/ada/src/books";
  const made = [
    session({ title: "alpha 1", cwd: shop, state: "idle" }),
    session({ title: "alpha 2", cwd: shop, state: "idle" }),
    session({ title: "alpha 3", cwd: shop, state: "idle" }),
    session({ title: "beta 1", cwd: books, state: "idle" }),
    session({ title: "beta 2", cwd: books, state: "idle" }),
    session({ title: "beta 3", cwd: books, state: "idle" }),
  ];
  const ids = Object.fromEntries(made.map((s) => [s.title, s.id]));
  const embed: Embed = async (_key, _model, texts) =>
    texts.map((text) => (text.includes("alpha") ? [1, 0, 0] : [0, 1, 0]));
  let named = 0;
  const chat: Chat = async (_key, _model, messages) => {
    const payload = JSON.parse(messages[1]?.content ?? "{}") as { items: { id: string }[] };
    named += 1;
    return JSON.stringify({
      name: `Subject${String.fromCharCode(96 + named)}`,
      sub: "named by the model",
      items: payload.items.map((i) => ({ id: i.id, lines: ["line one", "line two"] })),
      pairs: [],
    });
  };
  return { options: { sessions: made }, ids, deps: { embed, chat } };
}

/** Last time's topics: beta 3 sat with the alpha sessions. */
function oldTopics(ids: Record<string, string>) {
  const topicOf = Object.fromEntries(
    Object.entries(ids).map(([title, id]) => [
      id,
      title.startsWith("beta") && title !== "beta 3" ? "t2" : "t1",
    ]),
  );
  return { topicOf, nextId: 3 };
}

function themeOf(view: MapAnswer, id: string | undefined): string | undefined {
  return goodMap(view).map.nodes.find((n) => n.id === id)?.theme;
}

async function mapWith(saved: object) {
  const { options, ids, deps } = twoGroups();
  const api = fakeApi({ ...options, key: "k" });
  await api.state?.set("topics", { ...oldTopics(ids), ...saved });
  const map = new MindMap(api, deps);
  await map.load();
  return { api, ids, view: await settled(map, NOW) };
}

test("topics saved without embeddings are not sticky: a fresh run moves an item to where its embedding fits, with new ids", async () => {
  const { api, ids, view } = await mapWith({});
  expect(themeOf(view, ids["beta 3"])).toBe(themeOf(view, ids["beta 1"]));
  expect(themeOf(view, ids["beta 3"])).not.toBe(themeOf(view, ids["alpha 1"]));
  expect(goodMap(view).map.themes.some((t) => t.id === "t1" || t.id === "t2")).toBe(false);
  // Saved with the model, so the next run is sticky.
  await new Promise((done) => setTimeout(done, 0));
  expect(await api.state?.get("topics")).toMatchObject({ embedModel: EMBED_MODEL });
});

test("topics saved with this embedding model are sticky, as before: the ids are kept", async () => {
  const { ids, view } = await mapWith({ embedModel: EMBED_MODEL });
  expect(goodMap(view).map.themes.every((t) => t.id === "t1" || t.id === "t2")).toBe(true);
  expect(themeOf(view, ids["alpha 1"])).toBe("t1");
  expect(themeOf(view, ids["beta 1"])).toBe("t2");
});

test("topics saved with another embedding model are rebuilt too", async () => {
  const { ids, view } = await mapWith({ embedModel: "some/older-model" });
  expect(themeOf(view, ids["beta 3"])).toBe(themeOf(view, ids["beta 1"]));
  expect(goodMap(view).map.themes.some((t) => t.id === "t1" || t.id === "t2")).toBe(false);
});
