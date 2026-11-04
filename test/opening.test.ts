import { describe, expect, test } from "bun:test";
import { MindMap } from "../mindmap";
import { menuFor, whatsappLink } from "../opening";
import { gmailThreadUrl } from "../sources";
import type { Item } from "../types";
import { fakeApi, goodText, item, model, sentIn, session } from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000000";
const CARD_URL = "https://trello.com/c/abc123";

const GMAIL =
  "t9 | 1 msg | Mon, 02 Nov 2026 09:00:00 +0000 | Ada Lovelace <ada@example.com> | Refund question";
const CHATS = [
  "- **Grace Hopper** `46701234567@s.whatsapp.net` · 2026-11-02 10:00 UTC",
  "  See you at five",
  "- **Book club** (group) `b1@g.us` · 2026-11-02 09:00 UTC",
  "  [image]",
].join("\n");
const CARDS = JSON.stringify([
  { id: "c1", name: "Fix refunds", url: CARD_URL, sessionId: "aaaaaaaa" },
]);

/** The model groups everything in one topic and says the refund session and Ada's mail are about the same thing. */
function relating(request: Parameters<typeof goodText>[0]): string {
  const items = sentIn(request).items;
  const a = items.find((i) => i.title === "Refund bug")?.id;
  const b = items.find((i) => i.title.startsWith("Ada"))?.id;
  const base = JSON.parse(goodText(request)) as Record<string, unknown>;
  return JSON.stringify({ ...base, related: a && b ? [{ a, b, label: "refund" }] : [] });
}

async function drawn(open?: (url: string) => Promise<boolean>) {
  const asked: string[] = [];
  const api = fakeApi({
    sessions: [
      session({ id: SESSION_ID, title: "Refund bug", cwd: "/home/ada/src/shop", state: "working" }),
    ],
    ask: model(relating).ask,
    features: ["state", "llm-ask", "read-tools", ...(open ? ["open-url"] : [])],
    read: async (name) => {
      if (name === "gmail_search") return GMAIL;
      if (name === "whatsapp_chats") return CHATS;
      if (name === "trello_cards") return CARDS;
      throw new Error("not installed");
    },
    ...(open
      ? {
          open: async (url: string) => {
            asked.push(url);
            return open(url);
          },
        }
      : {}),
  });
  const map = new MindMap(api);
  map.view(NOW);
  await map.settle();
  const answer = map.view(NOW + 1000);
  if (answer.state !== "map") throw new Error(`expected a map, got ${answer.state}`);
  const node = (title: string) => {
    const found = answer.map.nodes.find((n) => n.title.startsWith(title));
    if (found === undefined) throw new Error(`no circle for ${title}`);
    return found;
  };
  return { map, node, asked };
}

describe("links", () => {
  test("WhatsApp: wa.me for a person, WhatsApp Web for a group or an id with no number", () => {
    expect(whatsappLink("46701234567@s.whatsapp.net")).toBe("https://wa.me/46701234567");
    expect(whatsappLink("46701234567:12@s.whatsapp.net")).toBe("https://wa.me/46701234567");
    expect(whatsappLink("120363041234567890@g.us")).toBe("https://web.whatsapp.com/");
    expect(whatsappLink("a1@lid")).toBe("https://web.whatsapp.com/");
  });

  test("Gmail and Trello links are as they were", async () => {
    expect(gmailThreadUrl("t9")).toBe("https://mail.google.com/mail/u/0/#all/t9");
    expect(gmailThreadUrl("t9", "ada@example.com")).toBe(
      "https://mail.google.com/mail/?authuser=ada@example.com#all/t9",
    );
    const { node } = await drawn();
    expect(node("Ada").url).toBe("https://mail.google.com/mail/u/0/#all/t9");
    expect(node("Fix refunds").url).toBe(CARD_URL);
    expect(node("Grace").url).toBe("https://wa.me/46701234567");
    expect(node("Book club").url).toBe("https://web.whatsapp.com/");
  });
});

describe("the menu", () => {
  test("a session lists prifly first, then its card and the conversations it is linked to", async () => {
    const { node } = await drawn();
    const refund = node("Refund bug");
    expect(refund.menu).toEqual([
      { label: "Open in prifly", target: refund.id, where: "prifly" },
      { label: "Open Fix refunds in Trello", target: node("Fix refunds").id, where: "browser" },
      { label: "Open Ada Lovelace in Gmail", target: node("Ada").id, where: "browser" },
    ]);
  });

  test("a conversation or card names its service; an item with no link has nowhere to open", async () => {
    const { node } = await drawn();
    expect(node("Ada").menu).toEqual([
      { label: "Open in Gmail", target: node("Ada").id, where: "browser" },
    ]);
    expect(node("Grace").menu[0]?.label).toBe("Open in WhatsApp");
    expect(node("Fix refunds").menu[0]?.label).toBe("Open in Trello");
    const bare: Item = item({ id: "c:outlook_search:x", kind: "conversation", repo: "Outlook" });
    expect(menuFor(bare, [bare], [])).toEqual([]);
  });
});

describe("api/open", () => {
  test("opens the item's own link in the browser", async () => {
    const { map, node, asked } = await drawn(async () => true);
    const ada = node("Ada");
    expect(await map.open({ id: ada.id, target: ada.id })).toEqual({ opened: true });
    const grace = node("Grace");
    await map.open({ id: grace.id, target: grace.id });
    expect(asked).toEqual([
      "https://mail.google.com/mail/u/0/#all/t9",
      "https://wa.me/46701234567",
    ]);
  });

  test("a session opens a linked card or conversation with the item's link, never one the page sends", async () => {
    const { map, node, asked } = await drawn(async () => true);
    await map.open({ id: node("Refund bug").id, target: node("Fix refunds").id });
    expect(asked).toEqual([CARD_URL]);
  });

  test("refuses an unknown item, an unknown target, a target the item does not have, and a URL", async () => {
    const { map, node, asked } = await drawn(async () => true);
    const session = node("Refund bug");
    const grace = node("Grace");
    await expect(map.open({ id: "nope", target: "nope" })).rejects.toThrow();
    await expect(map.open({ id: grace.id, target: "nope" })).rejects.toThrow();
    // Grace is not linked to the session, so the session's menu does not list her.
    await expect(map.open({ id: session.id, target: grace.id })).rejects.toThrow();
    // A conversation opens itself only.
    await expect(map.open({ id: grace.id, target: node("Ada").id })).rejects.toThrow();
    // A session opens in prifly, not in the browser.
    await expect(map.open({ id: session.id, target: session.id })).rejects.toThrow();
    await expect(map.open({ id: grace.id, target: "https://example.com/" })).rejects.toThrow();
    await expect(map.open({})).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  test("answers opened: false when prifly has no openUrl or says it did not open", async () => {
    const none = await drawn();
    expect(await none.map.open({ id: none.node("Ada").id, target: none.node("Ada").id })).toEqual({
      opened: false,
    });
    const refused = await drawn(async () => false);
    const ada = refused.node("Ada");
    expect(await refused.map.open({ id: ada.id, target: ada.id })).toEqual({ opened: false });
    const throwing = await drawn(async () => {
      throw new Error("no browser");
    });
    const same = throwing.node("Ada");
    expect(await throwing.map.open({ id: same.id, target: same.id })).toEqual({ opened: false });
  });
});
