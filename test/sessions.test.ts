import { expect, test } from "bun:test";
import { sessionItems } from "../sessions";
import { session } from "./fake";

const NOW = Date.parse("2026-11-02T12:00:00Z");

const THROWAWAY = [
  "/tmp/claude-1000/-home-jimmy-src-prifly-worktrees-prifly-566/0b1c/scratchpad/m/w",
  "/tmp",
  "/tmp/build/x",
  "/private/var/folders/ab/xyz/T/claude-501/-Users-ada-src-shop/1f2e/scratchpad",
  "/private/var/folders/ab/xyz/T/claude-501/-Users-ada-src-shop/1f2e/scratchpad/m/w",
  "C:\\Users\\jimmy\\AppData\\Local\\Temp\\claude\\proj\\abc\\scratchpad",
  "c:\\users\\jimmy\\appdata\\local\\temp\\probe",
  "C:/Users/jimmy/APPDATA/LOCAL/TEMP/x",
];

test("ended sessions in a throwaway folder are left out", () => {
  const sessions = THROWAWAY.map((cwd) => session({ title: "probe", cwd, state: "ended" }));
  expect(sessionItems(sessions, NOW)).toEqual([]);
});

test("live sessions in a throwaway folder stay", () => {
  const sessions = THROWAWAY.map((cwd) => session({ title: "probe", cwd, state: "working" }));
  expect(sessionItems(sessions, NOW).length).toBe(THROWAWAY.length);
});

test("an ended session in a normal repo is left out", () => {
  const cwds = ["/home/jimmy/src/odi.worktrees/odi-159", "/home/ada/src/shop"];
  const sessions = cwds.map((cwd) => session({ title: "Refund bug", cwd, state: "ended" }));
  expect(sessionItems(sessions, NOW)).toEqual([]);
});

test("ended probe-titled and untitled sessions are left out", () => {
  const cwd = "/home/jimmy/src/odi.worktrees/odi-159";
  const sessions = ["Run exactly this one Bash command, verbatim, once", "untitled", ""].map(
    (title) => session({ title, cwd, state: "ended" }),
  );
  expect(sessionItems(sessions, NOW)).toEqual([]);
});

const CWD = "/home/ada/src/shop";
const kept = (sessions: ReturnType<typeof session>[]) =>
  sessionItems(sessions, NOW).map((item) => item.id);

test("working, starting, agents and background sessions are kept as running", () => {
  const sessions = ["working", "starting", "agents", "background"].map((state) =>
    session({ cwd: CWD, state: state as "working" }),
  );
  expect(kept(sessions)).toEqual(sessions.map((s) => s.id));
  expect(sessionItems(sessions, NOW).every((i) => i.status === "running")).toBe(true);
});

test("waiting, asking the reader, and error sessions are kept", () => {
  const sessions = [
    session({ cwd: CWD, state: "waiting" }),
    session({ cwd: CWD, state: "idle", asksYou: true }),
    session({ cwd: CWD, state: "error" }),
  ];
  expect(sessionItems(sessions, NOW).map((i) => i.status)).toEqual(["waiting", "waiting", "error"]);
});

test("idle, snoozed (even in error or working), ended and archived sessions are dropped", () => {
  const snoozedUntil = new Date(NOW + 3_600_000).toISOString();
  const past = new Date(NOW - 3_600_000).toISOString();
  const dropped = [
    session({ cwd: CWD, state: "idle" }),
    session({ cwd: CWD, state: "working", snoozedUntil }),
    session({ cwd: CWD, state: "error", snoozedUntil }),
    session({ cwd: CWD, state: "waiting", snoozedUntil }),
    session({ cwd: CWD, state: "ended" }),
    session({ cwd: CWD, state: "working", archived: true }),
  ];
  expect(kept(dropped)).toEqual([]);
  // A snooze that has run out no longer hides the session.
  const woken = session({ cwd: CWD, state: "working", snoozedUntil: past });
  expect(kept([woken])).toEqual([woken.id]);
});

test("an agent's report and a summariser fold stay off even when running", () => {
  const sessions = [
    session({ cwd: CWD, state: "working", title: "# The agent's report" }),
    session({ cwd: "/home/ada/.local/prifly/host/summariser", state: "working" }),
  ];
  expect(kept(sessions)).toEqual([]);
});

test("an archived session is still left out", () => {
  const archived = session({
    title: "Old",
    cwd: "/home/ada/src/shop",
    state: "idle",
    archived: true,
  });
  expect(sessionItems([archived], NOW)).toEqual([]);
});
