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

test("an ended session in a normal repo stays", () => {
  const kept = session({ title: "Refund bug", cwd: "/home/ada/src/shop", state: "ended" });
  const others = ["/home/ada/src/tmp-tools", "/home/ada/src/claude-tools/notes"].map((cwd) =>
    session({ title: "Notes", cwd, state: "ended" }),
  );
  const ids = sessionItems([kept, ...others], NOW).map((item) => item.id);
  expect(ids.sort()).toEqual([kept, ...others].map((s) => s.id).sort());
});
