import { describe, expect, test } from "bun:test";
import { entitiesOf } from "../entities";
import { type Chat, MIN_GAP_MS, Namer, type TopicInfo } from "../model";
import { lineProblem, nameProblem } from "../rules";
import { namePrompt } from "../sorting";
import { fakeState, item } from "./fake";

const A = "aaaaaaaa-1111-4000-8000-000000000000";
const B = "bbbbbbbb-2222-4000-8000-000000000000";

const members = () => [
  item({ id: A, title: "Linux install", repo: "laptop" }),
  item({ id: B, title: "Refund bug", repo: "shop" }),
];
const topic = (id = "t1"): TopicInfo => ({ id, members: members(), pairs: [] });

function answer(name: string, a: string[], b: string[] = ["Customer waits", "for the money back"]) {
  return JSON.stringify({
    name,
    sub: "sub",
    items: [
      { id: "i1", lines: a },
      { id: "i2", lines: b },
    ],
    pairs: [],
  });
}

describe("the naming rules", () => {
  test("a theme name that shares its main word with another theme's is rejected", () => {
    expect(nameProblem("Prifly and ODI", ["Prifly Project"])?.kind).toBe("overlap");
    expect(nameProblem("ODI Support", ["Prifly and ODI"])?.kind).toBe("overlap");
    // Only filler in common is no overlap.
    expect(nameProblem("Tax Project", ["Garden Project"])).toBeNull();
    expect(nameProblem("Refund flow", ["Checkout redesign", "Linux install"])).toBeNull();
  });

  test("catch-all names are rejected", () => {
    for (const name of [
      "Digital Activity: Mixed",
      "Misc",
      "Other things",
      "General",
      "Personal and Work",
      "Various chats",
      "Övrigt",
    ])
      expect(nameProblem(name, [])?.kind).toBe("catch-all");
    expect(nameProblem("Family trip to Skåne", [])).toBeNull();
  });

  test("a line equal to, a prefix of, or inside the title is rejected, whatever its case or punctuation", () => {
    expect(lineProblem("Linux install", "Linux install")).not.toBeNull();
    expect(lineProblem("LINUX, install!", "Linux install")).not.toBeNull();
    expect(lineProblem("Linux…", "Linux install")).not.toBeNull();
    expect(lineProblem("install", "Linux install")).not.toBeNull();
    expect(lineProblem("Person contact", "Ada Lovelace")).not.toBeNull();
    expect(lineProblem("Message from Ada", "Ada Lovelace")).not.toBeNull();
    expect(lineProblem("Dual boot, needs a USB stick", "Linux install")).toBeNull();
  });

  test("the prompt sends the other themes' names and states the rules", () => {
    const [system, user] = namePrompt(members(), [], [], null, ["Prifly Project"]);
    expect(JSON.parse(user?.content ?? "{}").otherThemes).toEqual(["Prifly Project"]);
    expect(system?.content).toContain("otherThemes");
    expect(system?.content).toContain("Personal and Work");
    expect(system?.content).toContain("Person contact");
  });
});

describe("the namer's rules in use", () => {
  function run(answers: string[]) {
    const prompts: string[][] = [];
    const chat: Chat = async (_key, _model, messages) => {
      prompts.push(messages.map((m) => m.content));
      return answers[Math.min(prompts.length, answers.length) - 1] ?? "";
    };
    const namer = new Namer({ key: async () => "k", chat, state: fakeState() });
    return { namer, prompts };
  }
  const entities = () => entitiesOf(members());

  test("a good answer takes one call", async () => {
    const { namer, prompts } = run([answer("Laptop setup", ["Dual boot", "needs a USB stick"])]);
    await namer.update([topic()], entities(), 0);
    expect(prompts).toHaveLength(1);
    expect(namer.themeOf(topic())?.name).toBe("Laptop setup");
  });

  test("a title-repeating line asks once more with the reason; the fixed answer is kept", async () => {
    const { namer, prompts } = run([
      answer("Laptop setup", ["Linux install", "Linux install"]),
      answer("Laptop setup", ["Dual boot", "needs a USB stick"]),
    ]);
    await namer.update([topic()], entities(), 0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.join("\n")).toContain("repeats or shortens the title");
    expect(namer.linesOf(members()[0] ?? item({ id: "x" }))).toEqual([
      "Dual boot",
      "needs a USB stick",
    ]);
  });

  test("still repeating after the retry: asked only once more, and the line is left empty", async () => {
    const bad = answer("Laptop setup", ["Linux install", "linux"]);
    const { namer, prompts } = run([bad, bad, bad]);
    await namer.update([topic()], entities(), 0);
    expect(prompts).toHaveLength(2);
    expect(namer.linesOf(members()[0] ?? item({ id: "x" }))).toEqual([]);
    expect(namer.linesOf(members()[1] ?? item({ id: "x" }))).toEqual([
      "Customer waits",
      "for the money back",
    ]);
    expect(namer.themeOf(topic())?.name).toBe("Laptop setup");
    expect(namer.ready([topic()])).toBe(true);
  });

  /** A chat that answers each topic from its own script, found by a title in the prompt. */
  function scripted(scripts: Record<string, string[]>) {
    const prompts: { marker: string; messages: string[] }[] = [];
    const chat: Chat = async (_key, _model, messages) => {
      const marker = Object.keys(scripts).find((m) => messages[1]?.content.includes(m)) ?? "";
      prompts.push({ marker, messages: messages.map((m) => m.content) });
      return scripts[marker]?.shift() ?? "";
    };
    return { namer: new Namer({ key: async () => "k", chat, state: fakeState() }), prompts };
  }
  const weeding = (ids: string[]): TopicInfo => ({
    id: "t2",
    members: ids.map((id) => item({ id, title: "Weeding the beds" })),
    pairs: [],
  });
  const C = [
    "cccccccc-3333-4000-8000-000000000000",
    "dddddddd-4444-4000-8000-000000000000",
    "eeeeeeee-5555-4000-8000-000000000000",
  ];
  const lines = ["Dual boot", "needs a USB stick"];

  test("each call is sent the other themes' names; an overlap is retried once and, with no earlier name, kept", async () => {
    const one = answer("Shop refunds", lines);
    const two = JSON.stringify({ name: "Refunds", sub: "x", items: [], pairs: [] });
    const { namer, prompts } = scripted({
      "Linux install": [one],
      "Weeding the beds": [two, two],
    });
    const second = weeding(C.slice(0, 1));
    await namer.update([topic(), second], entities(), 0);
    const others = prompts.map((p) => JSON.parse(p.messages[1] ?? "{}").otherThemes);
    expect(others).toEqual([[], ["Shop refunds"], ["Shop refunds"]]);
    expect(prompts[2]?.messages.join("\n")).toContain('shares "refunds"');
    expect(prompts.filter((p) => p.marker === "Weeding the beds")).toHaveLength(2);
    expect(namer.themeOf(second)?.name).toBe("Refunds");
  });

  test("an overlap that stays after the retry keeps the topic's last good name", async () => {
    const garden = JSON.stringify({ name: "Garden", sub: "x", items: [], pairs: [] });
    const clash = JSON.stringify({ name: "Shop refunds again", sub: "x", items: [], pairs: [] });
    const { namer, prompts } = scripted({
      "Linux install": [answer("Shop refunds", lines)],
      "Weeding the beds": [garden, clash, clash],
    });
    await namer.update([topic(), weeding(C)], entities(), 0);
    expect(namer.themeOf(weeding(C))?.name).toBe("Garden");
    // The garden loses two of its three members, so it is named anew, and the model clashes twice.
    const smaller = weeding(C.slice(0, 1));
    await namer.update([topic(), smaller], entities(), MIN_GAP_MS * 2);
    expect(prompts.filter((p) => p.marker === "Weeding the beds")).toHaveLength(3);
    expect(namer.themeOf(smaller)?.name).toBe("Garden");
  });

  test("a catch-all name with no earlier name is retried once, then the topic stays unnamed", async () => {
    const mixed = answer("Mixed", ["Dual boot", "needs a USB stick"]);
    const { namer, prompts } = run([mixed, mixed, mixed]);
    await namer.update([topic()], entities(), 0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.join("\n")).toContain("catch-all");
    expect(namer.themeOf(topic())).toBeNull();
    expect(namer.error()).toMatchObject({ call: "naming" });
  });
});
