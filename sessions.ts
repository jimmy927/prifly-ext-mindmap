/** prifly's sessions as items of the map: which to leave out, and what each says. */

import type { FactSession, Item, Status } from "./types";

/** At most this many sessions are drawn, in the order `api.sessions()` gives them. */
export const MAX_SESSIONS = 40;

/** The folder prifly's summariser runs its folds in (`foldHome` in prifly's session-summary.ts). */
function isSummariserFolder(cwd: string): boolean {
  return /[\\/]prifly[\\/](?:host[\\/])?summariser[\\/]?$/i.test(cwd);
}

/**
 * A leftover nobody looks at: an ended session (whatever its folder or title:
 * probes, untitled sessions, reports and folds end up there), an archived one,
 * an agent's report or a summariser fold. Every other state stays, a snoozed
 * session too.
 */
export function isLeftover(session: FactSession): boolean {
  if (session.state === "ended" || session.archived === true) return true;
  if (session.title.trim().startsWith("# The agent's report")) return true;
  return isSummariserFolder(session.cwd);
}

/** "C:\src\prifly-ext-mindmap.worktrees\x" → "prifly-ext-mindmap"; a checkout's worktrees fold into it. */
export function repoOfFolder(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter((part) => part !== "");
  const worktrees = parts.findIndex(
    (part, i) =>
      part.endsWith(".worktrees") || (part === ".claude" && parts[i + 1] === "worktrees"),
  );
  const cut = worktrees === -1 ? parts : parts.slice(0, worktrees + 1);
  const last = cut.at(-1) ?? "";
  if (last === ".claude") return cut.at(-2) ?? "";
  return last.replace(/\.worktrees$/, "");
}

/** "jimmy927/prifly" → "prifly". */
function repoName(repo: string): string {
  return repo.split("/").at(-1) ?? repo;
}

function snoozed(session: FactSession, now: number): boolean {
  const until = session.snoozedUntil;
  if (typeof until !== "string") return false;
  const at = Date.parse(until);
  return Number.isFinite(at) && at > now;
}

/** The dot on the rim: green running, amber waiting on you, red error, grey idle or snoozed. */
export function statusOf(session: FactSession, now: number): Status {
  if (session.state === "error") return "error";
  if (snoozed(session, now)) return "idle";
  if (session.asksYou === true || session.state === "waiting") return "waiting";
  if (["working", "starting", "agents", "background"].includes(session.state)) return "running";
  return "idle";
}

/** The brief's lines, most pressing first. Empty without a brief. */
export function briefLines(session: FactSession): string[] {
  const brief = session.brief;
  if (brief === undefined) return [];
  return [
    ...(brief.blockedOnYou ?? []),
    ...(brief.blocked ?? []),
    ...(brief.next ?? []),
    ...(brief.done ?? []),
  ].filter((line) => typeof line === "string" && line.trim() !== "");
}

/** The first line of a title: some are whole prompts. */
function titleOf(session: FactSession): string {
  return (session.title.split("\n")[0] ?? "").trim();
}

function itemOf(session: FactSession, now: number): Item {
  const item: Item = {
    id: session.id,
    kind: "session",
    title: titleOf(session),
    repo: session.repo ? repoName(session.repo) : repoOfFolder(session.cwd),
    brief: briefLines(session),
    status: statusOf(session, now),
  };
  if (typeof session.parentId === "string" && session.parentId !== "") {
    item.parentId = session.parentId;
  }
  if (Array.isArray(session.waitsOn) && session.waitsOn.length > 0) {
    item.waitsOn = session.waitsOn.filter((id) => typeof id === "string" && id !== "");
  }
  return item;
}

/** The sessions worth a circle, as items: leftovers dropped, at most `MAX_SESSIONS`. */
export function sessionItems(sessions: readonly FactSession[], now: number): Item[] {
  return sessions
    .filter((session) => !isLeftover(session))
    .slice(0, MAX_SESSIONS)
    .map((session) => itemOf(session, now));
}
