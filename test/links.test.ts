import { expect, test } from "bun:test";
import { knownLinks, relatedLinks } from "../links";
import { sessionItems } from "../sessions";
import { item, session } from "./fake";

test("parentId gives a solid started link from the parent", () => {
  const parent = session({ title: "Plan the release" });
  const child = session({ title: "Write the notes", parentId: parent.id });
  const links = knownLinks(sessionItems([parent, child], 0));
  expect(links).toEqual([{ a: parent.id, b: child.id, kind: "started", label: "started" }]);
});

test("each waitsOn id is matched by its first 8 characters", () => {
  const blocker = session({ title: "Migrate the database" });
  const waiting = session({ title: "Ship the API", waitsOn: [blocker.id.slice(0, 8), "ffffffff"] });
  const links = knownLinks(sessionItems([blocker, waiting], 0));
  expect(links).toEqual([{ a: waiting.id, b: blocker.id, kind: "waits on", label: "waits on" }]);
});

test("a card's sessionId gives a ticket link", () => {
  const work = session({ title: "Fix the bug" });
  const card = item({ id: "k:c1", kind: "card", repo: "Trello", sessionId: work.id.slice(0, 8) });
  const links = knownLinks([...sessionItems([work], 0), card]);
  expect(links).toEqual([{ a: "k:c1", b: work.id, kind: "ticket", label: "ticket" }]);
});

test("without session facts there are no solid links", () => {
  expect(knownLinks(sessionItems([session(), session()], 0))).toEqual([]);
});

test("a related link the model sees is dropped where a solid one joins the pair", () => {
  const parent = session();
  const child = session({ parentId: parent.id });
  const items = sessionItems([parent, child], 0);
  const known = knownLinks(items);
  const sorting = {
    themes: [],
    themeOf: {},
    lines: {},
    related: [
      { a: child.id, b: parent.id, label: "same" },
      { a: child.id, b: "gone", label: "x" },
    ],
  };
  expect(relatedLinks(items, sorting, known)).toEqual([]);
});
