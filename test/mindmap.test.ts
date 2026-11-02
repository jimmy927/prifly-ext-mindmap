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

test("the same view twice keeps every position", () => {
  const map = new MindMap(fakeApi({ sessions: sessions() }));
  const one = map.view(NOW);
  const two = map.view(NOW + 1000);
  expect(two.nodes).toEqual(one.nodes);
});
