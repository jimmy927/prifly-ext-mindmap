/**
 * Where an item can be opened. A session opens inside prifly; a conversation
 * or a card opens in the reader's own browser through `api.openUrl` (never
 * `window.open`, which inside prifly's webview is not the reader's browser).
 * The page never sends a URL: it names an item and one of that item's menu
 * entries, and the extension looks the link up itself.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import type { Item, Link } from "./types";

/** One line of the right-click menu. `target` is the id of the item it opens. */
export type MenuEntry = {
  label: string;
  target: string;
  /** "prifly": a session, opened in prifly. "browser": a link, opened in the reader's browser. */
  where: "prifly" | "browser";
};

/** Linked cards and conversations listed under a session. */
export const MAX_LINKED = 8;
const TITLE_CHARS = 28;

/**
 * THE one place that turns a WhatsApp chat id into a (web) link. Only a real
 * phone id (`<digits>@s.whatsapp.net` or `@c.us`) gets `https://wa.me/<number>`;
 * every other id (`@lid`, WhatsApp's internal linked id, which is not a phone
 * number, or a group's `@g.us`) is WhatsApp Web. Without the prifly feature "open-url-apps", `openUrl` accepts
 * only http and https, so this is what opens; with it, `appLinkOf` turns the
 * same link into the app's.
 */
export function whatsappLink(chatId: string): string {
  const person = chatId.match(/^(\d{5,})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/i);
  return person === null ? "https://web.whatsapp.com/" : `https://wa.me/${person[1]}`;
}

/** What opening `item` in the browser goes to: its link, when it is a web link. */
export function linkOf(item: Item): string | undefined {
  return item.url !== undefined && /^https?:\/\//i.test(item.url) ? item.url : undefined;
}

/**
 * The desktop-app link for `item`, or undefined when it has none (Gmail,
 * Outlook and the rest stay web links). WhatsApp chat with a real phone id:
 * `whatsapp://send?phone=<digits>`; any other WhatsApp chat (`@lid`, `@g.us`):
 * `whatsapp://` (the app itself). Trello card: Atlassian's
 * `trello://trello.com/c/<shortlink>` (the form that opens the card in the
 * Trello Windows app), the shortlink being taken from the card url
 * `https://trello.com/c/<shortlink>/...`.
 */
export function appLinkOf(item: Item): string | undefined {
  const url = linkOf(item);
  if (url === undefined) return undefined;
  if (item.repo === "WhatsApp") {
    const person = url.match(/^https:\/\/wa\.me\/(\d+)$/i);
    return person === null ? "whatsapp://" : `whatsapp://send?phone=${person[1]}`;
  }
  if (item.repo === "Trello") {
    const card = url.match(/^https:\/\/trello\.com\/c\/([^/?#]+)/i);
    return card === null
      ? undefined
      : `trello://trello.com/c/${encodeURIComponent(card[1] ?? "")}`;
  }
  return undefined;
}

/** True where this prifly's `openUrl` also opens `whatsapp:` and `trello:` links (feature "open-url-apps"). */
export function opensApps(api: ExtensionApi): boolean {
  return (api.features ?? []).includes("open-url-apps");
}

function cut(title: string): string {
  const text = title.replace(/\s+/g, " ").trim();
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text;
}

/** The cards and conversations a session has a link to (ticket, related), cards first, with a link of their own. */
function linkedTo(session: Item, items: readonly Item[], links: readonly Link[]): Item[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const found: Item[] = [];
  for (const link of links) {
    const otherId = link.a === session.id ? link.b : link.b === session.id ? link.a : null;
    const other = otherId === null ? undefined : byId.get(otherId);
    if (other === undefined || other.kind === "session" || seen.has(other.id)) continue;
    if (linkOf(other) === undefined) continue;
    seen.add(other.id);
    found.push(other);
  }
  const rank = (item: Item) => (item.kind === "card" ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_LINKED);
}

/**
 * Every place `item` can be opened, the first being what a left-click does.
 * A session: prifly, then its linked cards and conversations. A conversation
 * or card: its service, when it has a link. Empty: nowhere to open.
 */
export function menuFor(item: Item, items: readonly Item[], links: readonly Link[]): MenuEntry[] {
  if (item.kind !== "session") {
    return linkOf(item) === undefined
      ? []
      : [{ label: `Open in ${item.repo}`, target: item.id, where: "browser" }];
  }
  return [
    { label: "Open in prifly", target: item.id, where: "prifly" },
    ...linkedTo(item, items, links).map(
      (other): MenuEntry => ({
        label: `Open ${cut(other.title)} in ${other.repo}`,
        target: other.id,
        where: "browser",
      }),
    ),
  ];
}

/** `api.openUrl` where this prifly has it (feature "open-url"), else null. */
export function openerOf(api: ExtensionApi): ((url: string) => Promise<boolean>) | null {
  if (!(api.features ?? []).includes("open-url")) return null;
  const open = api.openUrl;
  return typeof open === "function" ? (url) => open.call(api, url) : null;
}

/** The item id and target a page names to `api/open`; a throw when the body is not that. */
export function openRequest(body: unknown): { id: string; target: string } {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const { id, target } = record;
  if (typeof id !== "string" || typeof target !== "string" || id === "" || target === "")
    throw new Error("Say which item and where to open it.");
  return { id, target };
}
