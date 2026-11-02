import { expect, test } from "bun:test";
import { MindMap, SESSIONS_EVERY_MS } from "../mindmap";
import type { FactSession } from "../types";
import { fakeApi, session } from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");

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

test("without the new features: sessions only, themed by repository, leftovers dropped", async () => {
  const api = fakeApi({ sessions: sessions() });
  const map = new MindMap(api);
  const view = map.view(NOW);
  await map.settle();
  expect(view.nodes.map((n) => n.title).sort()).toEqual([
    "Checkout redesign",
    "Refund bug",
    "Tax report",
  ]);
  expect(view.themes.map((t) => t.name).sort()).toEqual(["books", "shop"]);
  expect(view.nodes.find((n) => n.title === "Refund bug")?.status).toBe("waiting");
  expect(view.links).toEqual([]);
  expect(api.reads).toEqual([]);
  expect(view.footer.skipped).toEqual([]);
});

test("an archived session is left out and does not count towards the cap; an unarchived one stays", () => {
  const shape = { cwd: "/home/ada/src/shop", state: "working" as const };
  const live = [
    session({ ...shape, title: "Kept plain" }),
    session({ ...shape, title: "Kept explicit", archived: false }),
    session({ ...shape, title: "Archived one", archived: true }),
  ];
  const titles = (list: FactSession[]) =>
    new MindMap(fakeApi({ sessions: list }))
      .view(NOW)
      .nodes.map((n) => n.title)
      .sort();
  expect(titles(live)).toEqual(["Kept explicit", "Kept plain"]);

  // 40 archived ones ahead of a kept one: the kept one still fits under the cap.
  const many = Array.from({ length: 40 }, (_, i) =>
    session({ ...shape, title: `Old ${i}`, archived: true }),
  );
  expect(titles([...many, session({ ...shape, title: "Last kept" })])).toEqual(["Last kept"]);
});

test("a new session shows on the next read of sessions, within 15 s", () => {
  const list = sessions();
  const api = fakeApi({ sessions: list });
  const map = new MindMap(api);
  map.view(NOW);
  list.push(session({ title: "Brand new", cwd: "/home/ada/src/shop", state: "starting" }));
  expect(map.view(NOW + 1000).nodes.some((n) => n.title === "Brand new")).toBe(false);
  expect(map.view(NOW + SESSIONS_EVERY_MS).nodes.some((n) => n.title === "Brand new")).toBe(true);
});

test("with read tools: a conversation joins, a failing source is named in the footer", async () => {
  const api = fakeApi({
    sessions: sessions(),
    features: ["state", "read-tools"],
    read: async (name) => {
      if (name === "whatsapp_chats")
        return "- **Ada** `a1` · 2026-11-02 11:00 UTC\n  About the refund";
      throw new Error("not installed");
    },
  });
  const map = new MindMap(api);
  map.view(NOW);
  await map.settle();
  const view = map.view(NOW + 1000);
  const chat = view.nodes.find((n) => n.kind === "conversation");
  expect(chat).toMatchObject({ title: "Ada", service: "WhatsApp" });
  expect(view.footer.skipped).toContain("Gmail (not installed)");
  expect(view.legend.services.map((s) => s.name)).toEqual(["WhatsApp"]);
});

const PEOPLE_READ = async (name: string) => {
  if (name === "whatsapp_chats")
    return [
      "- **Ada Lovelace** `4670000001@s.whatsapp.net` · 2026-11-02 11:00 UTC",
      "  Did the refund go through?",
      "- **Bob Builder** `4670000002@s.whatsapp.net` · 2026-11-02 10:00 UTC",
      "  The tax numbers are in",
    ].join("\n");
  if (name === "gmail_search")
    return [
      "t1 | 1 msg | Mon, 02 Nov 2026 09:00:00 +0000 | Ada Lovelace <ada@lovelace-labs.com> | Refund for order 1042",
      "t2 | 1 msg | Mon, 02 Nov 2026 08:00:00 +0000 | Bob Builder <bob@builder-ab.se> | Q3 tax report",
    ].join("\n");
  throw new Error("not installed");
};

function peopleSessions(): FactSession[] {
  return [
    session({ title: "Reply to Ada about the refund", cwd: "/home/ada/src/shop" }),
    session({ title: "Tax report for Bob", cwd: "/home/ada/src/books" }),
  ];
}

test("no key: still clusters by shared people across services, and the footer says so", async () => {
  const api = fakeApi({
    sessions: peopleSessions(),
    features: ["state", "read-tools"],
    read: PEOPLE_READ,
    key: null,
  });
  const map = new MindMap(api, {
    chat: async () => {
      throw new Error("no call without a key");
    },
  });
  map.view(NOW);
  await map.settle();
  const view = map.view(NOW + 1000);
  const themeOf = (title: string, service?: string) =>
    view.nodes.find((n) => n.title.startsWith(title) && n.service === service)?.theme;
  const ada = themeOf("Reply to Ada");
  expect(ada).toBeDefined();
  expect(themeOf("Ada Lovelace", "WhatsApp")).toBe(ada ?? "");
  expect(themeOf("Ada Lovelace", "Gmail")).toBe(ada ?? "");
  expect(themeOf("Bob Builder", "WhatsApp")).toBe(themeOf("Tax report") ?? "");
  expect(view.themes.find((t) => t.id === ada)?.name).toBe("Ada");
  expect(view.footer.model).toContain("No DeepInfra key");
  const labels = view.links.filter((l) => l.kind === "related").map((l) => l.label.text);
  expect(labels).toContain("Ada");
});

test("with a key: the model names each topic in one short call, and the footer names both models", async () => {
  const api = fakeApi({
    sessions: peopleSessions(),
    features: ["state", "read-tools"],
    read: PEOPLE_READ,
    key: "k",
  });
  const prompts: string[] = [];
  const map = new MindMap(api, {
    embed: async (_key, _model, texts) => texts.map(() => [1, 0, 0]),
    chat: async (_key, _model, messages) => {
      const payload = JSON.parse(messages[1]?.content ?? "{}") as { items: { id: string }[] };
      prompts.push(messages[1]?.content ?? "");
      return JSON.stringify({
        name: payload.items.length > 2 ? "Customer care" : "Bookkeeping",
        sub: "named by the model",
        items: payload.items.map((i) => ({ id: i.id, lines: ["line one", "line two"] })),
        pairs: [],
      });
    },
  });
  map.view(NOW);
  await map.settle();
  const view = map.view(NOW + 1000);
  expect(prompts.length).toBe(view.themes.length);
  expect(view.themes.map((t) => t.sub)).toContain("named by the model");
  expect(view.footer.model).toBe("Names by gemma-4-26B-A4B-it · similarity by embeddinggemma-300m");
});

test("the same view twice keeps every position", () => {
  const map = new MindMap(fakeApi({ sessions: sessions() }));
  const one = map.view(NOW);
  const two = map.view(NOW + 1000);
  expect(two.nodes).toEqual(one.nodes);
});
