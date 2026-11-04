import { expect, test } from "bun:test";
import { type MapAnswer, MindMap } from "../mindmap";
import type { FactSession } from "../types";
import { fakeApi, groupingCalls, model, session } from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const MINUTE = 60_000;
const SHOP = "/home/ada/src/shop";

function goodMap(answer: MapAnswer) {
  if (answer.state !== "map") throw new Error(`expected a map, got ${JSON.stringify(answer)}`);
  return answer;
}

async function settled(map: MindMap, now: number): Promise<MapAnswer> {
  map.view(now);
  await map.settle();
  return map.view(now + 1000);
}

function three(): FactSession[] {
  return [
    session({ title: "Checkout redesign", cwd: SHOP, state: "working" }),
    session({ title: "Refund bug", cwd: SHOP, state: "waiting" }),
    session({ title: "Tax report", cwd: "/home/ada/src/books", state: "working" }),
  ];
}

function mustFind(sessions: FactSession[], title: string): FactSession {
  const found = sessions.find((s) => s.title === title);
  if (found === undefined) throw new Error(`no session ${title}`);
  return found;
}

test("a status or brief change re-renders at once with the grouping that stands, and asks nothing", async () => {
  const fake = model();
  const sessions = three();
  const map = new MindMap(fakeApi({ sessions, ask: fake.ask }));
  goodMap(await settled(map, NOW));
  expect(groupingCalls(fake.calls)).toHaveLength(1);

  const changed = mustFind(sessions, "Checkout redesign");
  changed.state = "error";
  changed.brief = { done: [], next: ["fix the build"], blocked: [], blockedOnYou: [] };
  const answer = goodMap(map.view(NOW + 5 * MINUTE));
  expect(answer.current).toBe(true);
  expect(answer.map.nodes.find((n) => n.title === "Checkout redesign")?.status).toBe("error");
  await map.settle();
  expect(groupingCalls(fake.calls)).toHaveLength(1);
});

test("a new item renders the map without it at once, then joins after the grouping answers", async () => {
  const fake = model();
  const sessions = three();
  const map = new MindMap(fakeApi({ sessions, ask: fake.ask }));
  goodMap(await settled(map, NOW));
  sessions.push(session({ title: "Brand new", cwd: SHOP, state: "working" }));
  mustFind(sessions, "Refund bug").state = "error";

  // Inside the minute the model is not asked: the map is drawn from the answer it has.
  const early = goodMap(map.view(NOW + 20_000));
  expect(early.current).toBe(false);
  expect(early.map.nodes.map((n) => n.title).sort()).toEqual([
    "Checkout redesign",
    "Refund bug",
    "Tax report",
  ]);
  expect(early.map.nodes.find((n) => n.title === "Refund bug")?.status).toBe("error");

  const later = goodMap(await settled(map, NOW + MINUTE + 1000));
  expect(later.current).toBe(true);
  expect(later.map.nodes.map((n) => n.title)).toContain("Brand new");
});

test("a saved map never shows an item that is no longer on the map", async () => {
  const parent = session({ title: "Parent job", cwd: SHOP, state: "working" });
  const child = session({ title: "Child job", cwd: SHOP, state: "working", parentId: parent.id });
  const other = session({ title: "Other job", cwd: "/home/ada/src/books", state: "working" });
  const sessions = [parent, child, other];
  const options = { sessions, ask: model().ask, features: ["state", "llm-ask"] };
  const api = fakeApi(options);
  const first = new MindMap(api);
  const before = goodMap(await settled(first, NOW));
  expect(before.map.links.some((l) => l.kind === "started")).toBe(true);

  // The grouping answer is gone as well: only the saved map is left to show.
  await new Promise((done) => setTimeout(done, 0));
  await api.state?.delete("grouping");
  options.features = ["state"];
  sessions.splice(1, 1); // the child is gone
  const next = new MindMap(api);
  await next.load();
  const shown = goodMap(next.view(NOW + 5 * MINUTE));
  expect(shown.current).toBe(false);
  expect(shown.map.nodes.map((n) => n.title).sort()).toEqual(["Other job", "Parent job"]);
  expect(shown.map.links).toEqual([]);
  expect(shown.map.footer.sessions).toBe(2);
});

test("a stale saved map is never shown when its items are all gone", async () => {
  const sessions = three();
  const options = { sessions, ask: model().ask, features: ["state", "llm-ask"] };
  const api = fakeApi(options);
  goodMap(await settled(new MindMap(api), NOW));

  await new Promise((done) => setTimeout(done, 0));
  await api.state?.delete("grouping");
  options.features = ["state"];
  // Three other sessions now; none is in the saved map, and nothing can group them.
  sessions.splice(0, 3, session({ title: "Fresh one", cwd: SHOP, state: "working" }));
  const next = new MindMap(api);
  await next.load();
  const answer = next.view(NOW + 5 * MINUTE);
  expect(answer.state).toBe("error");
});
