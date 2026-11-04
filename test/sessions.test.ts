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
  const sessions = [
    "Run exactly this one Bash command, verbatim, once",
    "untitled",
    "",
  ].map((title) => session({ title, cwd, state: "ended" }));
  expect(sessionItems(sessions, NOW)).toEqual([]);
});

test("idle, waiting, working and snoozed sessions are kept", () => {
  const cwd = "/home/ada/src/shop";
  const snoozedUntil = new Date(NOW + 3_600_000).toISOString();
  const kept = [
    session({ title: "A", cwd, state: "idle" }),
    session({ title: "B", cwd, state: "waiting" }),
    session({ title: "C", cwd, state: "working" }),
    session({ title: "D", cwd, state: "idle", snoozedUntil }),
  ];
  const ended = session({ title: "E", cwd, state: "ended" });
  const ids = sessionItems([ended, ...kept], NOW).map((item) => item.id);
  expect(ids).toEqual(kept.map((s) => s.id));
});

test("an archived session is still left out", () => {
  const archived = session({ title: "Old", cwd: "/home/ada/src/shop", state: "idle", archived: true });
  expect(sessionItems([archived], NOW)).toEqual([]);
});
