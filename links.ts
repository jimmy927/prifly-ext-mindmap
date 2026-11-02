/**
 * The links between items: the solid ones prifly knows (a session started by
 * another, a session that waits on another, a card that is a session's
 * ticket) and the dashed "related" ones between items that share an entity or
 * that the model finds about the same thing.
 */

import type { Item, Link, Sorting } from "./types";

/** The one session whose id starts with `prefix` (8 characters or more), or null. */
function sessionWith(prefix: string, sessions: readonly Item[]): Item | null {
  const key = prefix.trim().toLowerCase();
  if (key.length < 8) return null;
  const found = sessions.filter((item) => item.id.toLowerCase().startsWith(key));
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** Links from `parentId`, `waitsOn` and a card's `sessionId`, for items on the map only. */
export function knownLinks(items: readonly Item[]): Link[] {
  const sessions = items.filter((item) => item.kind === "session");
  const links: Link[] = [];
  const seen = new Set<string>();
  const add = (link: Link) => {
    const key = `${link.a}>${link.b}>${link.kind}`;
    if (link.a === link.b || seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };
  for (const item of items) for (const link of linksOf(item, sessions)) add(link);
  return links;
}

/** One item's own solid links: from the session that started it, to those it waits on, to its card's session. */
function linksOf(item: Item, sessions: readonly Item[]): Link[] {
  const links: Link[] = [];
  const parent = item.parentId === undefined ? null : sessionWith(item.parentId, sessions);
  if (parent !== null) links.push({ a: parent.id, b: item.id, kind: "started", label: "started" });
  for (const id of item.waitsOn ?? []) {
    const other = sessionWith(id, sessions);
    if (other !== null)
      links.push({ a: item.id, b: other.id, kind: "waits on", label: "waits on" });
  }
  const ticket =
    item.kind === "card" && item.sessionId !== undefined
      ? sessionWith(item.sessionId, sessions)
      : null;
  if (ticket !== null) links.push({ a: item.id, b: ticket.id, kind: "ticket", label: "ticket" });
  return links;
}

/** The sorting's related links between items on the map, minus pairs a known link already joins. */
export function relatedLinks(
  items: readonly Item[],
  sorting: Sorting,
  known: readonly Link[],
): Link[] {
  const ids = new Set(items.map((item) => item.id));
  const joined = new Set(known.flatMap((link) => [`${link.a}|${link.b}`, `${link.b}|${link.a}`]));
  const links: Link[] = [];
  for (const { a, b, label } of sorting.related) {
    if (a === b || !ids.has(a) || !ids.has(b) || joined.has(`${a}|${b}`)) continue;
    joined.add(`${a}|${b}`);
    joined.add(`${b}|${a}`);
    links.push({ a, b, kind: "related", label });
  }
  return links;
}
