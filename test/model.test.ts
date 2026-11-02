import { describe, expect, test } from "bun:test";
import { type Chat, MIN_GAP_MS, Sorter } from "../model";
import { fallbackSorting, fingerprint, parseAnswer, shortIds } from "../sorting";
import { fakeState, item } from "./fake";

const A = "aaaaaaaa-1111-4000-8000-000000000000";
const B = "bbbbbbbb-2222-4000-8000-000000000000";

function items() {
  return [
    item({ id: A, title: "Fix the login page", repo: "shop", brief: ["Tests pass", "Ship it"] }),
    item({ id: B, title: "Invoice export", repo: "books" }),
    item({
      id: "c:gmail_search:t1",
      kind: "conversation",
      title: "Ada",
      repo: "Gmail",
      subject: "Login broken",
      head: "Hi",
    }),
  ];
}

function answerFor(list = items()): string {
  const ids = shortIds(list);
  return JSON.stringify({
    themes: [
      { id: "t1", name: "Shop", sub: "the web shop" },
      { id: "t2", name: "Books", sub: "accounting" },
    ],
    items: [
      { id: ids.get(A), theme: "t1", lines: ["Login fix", "Waiting on CI and a review"] },
      { id: ids.get(B), theme: "t2", lines: ["CSV export", "Half done"] },
      { id: ids.get("c:gmail_search:t1"), theme: "t1", lines: ["Ada says login", "is broken"] },
    ],
    related: [{ a: ids.get(A), b: ids.get("c:gmail_search:t1"), label: "about" }],
  });
}

describe("the fingerprint", () => {
  test("changes with a title, a brief line or a conversation head, not with order", () => {
    const base = items();
    const print = fingerprint(base);
    expect(fingerprint([...base].reverse())).toBe(print);
    expect(fingerprint(base.map((i) => (i.id === A ? { ...i, title: "Other" } : i)))).not.toBe(
      print,
    );
    expect(fingerprint(base.map((i) => (i.id === A ? { ...i, brief: ["New"] } : i)))).not.toBe(
      print,
    );
    expect(
      fingerprint(base.map((i) => (i.kind === "conversation" ? { ...i, head: "Bye" } : i))),
    ).not.toBe(print);
    expect(fingerprint(base.map((i) => ({ ...i, status: "running" as const })))).toBe(print);
  });
});

describe("asking the model", () => {
  function sorter(key: string | null = "k") {
    const calls: number[] = [];
    const chat: Chat = async () => {
      calls.push(1);
      return answerFor();
    };
    const state = fakeState();
    return { sorter: new Sorter({ key: async () => key, chat, state }), calls, state };
  }

  test("asks once for the same items, and caches the answer in api.state", async () => {
    const { sorter: s, calls, state } = sorter();
    await s.update(items(), 0);
    await s.update(items(), MIN_GAP_MS * 5);
    expect(calls.length).toBe(1);
    expect(state.docs.has("sorting")).toBe(true);
    expect(s.sortingFor(items()).themeOf[A]).toBe("t1");
  });

  test("asks again for changed items, but not within a minute of the last ask", async () => {
    const { sorter: s, calls } = sorter();
    await s.update(items(), 0);
    const changed = items().map((i) => (i.id === B ? { ...i, title: "Invoice export v2" } : i));
    await s.update(changed, MIN_GAP_MS - 1);
    expect(calls.length).toBe(1);
    await s.update(changed, MIN_GAP_MS);
    expect(calls.length).toBe(2);
  });

  test("a restart reads the cached answer and does not ask again", async () => {
    const first = sorter();
    await first.sorter.update(items(), 0);
    const calls: number[] = [];
    const again = new Sorter({
      key: async () => "k",
      chat: async () => {
        calls.push(1);
        return answerFor();
      },
      state: first.state,
    });
    await again.load();
    await again.update(items(), MIN_GAP_MS * 10);
    expect(calls.length).toBe(0);
    expect(again.sortingFor(items()).by).toStartWith("model");
  });

  test("with no key it never calls, and themes by repository", async () => {
    const { sorter: s, calls } = sorter(null);
    await s.update(items(), 0);
    expect(calls.length).toBe(0);
    const sorting = s.sortingFor(items());
    expect(sorting.by).toBe("fallback");
    expect(sorting.themeOf[A]).toBe("r:shop");
    expect(sorting.themeOf["c:gmail_search:t1"]).toBe("r:Gmail");
    expect(s.statusLine()).toContain("No DeepInfra key");
  });

  test("a failed call leaves the fallback", async () => {
    const s = new Sorter({
      key: async () => "k",
      chat: async () => {
        throw new Error("HTTP 500");
      },
    });
    await s.update(items(), 0);
    expect(s.sortingFor(items()).by).toBe("fallback");
    expect(s.statusLine()).toContain("failed");
  });

  test("a key added later is used for the same items after a minute", async () => {
    let key: string | null = null;
    const calls: number[] = [];
    const s = new Sorter({
      key: async () => key,
      chat: async () => {
        calls.push(1);
        return answerFor();
      },
    });
    await s.update(items(), 0);
    expect(calls.length).toBe(0);
    key = "k";
    await s.update(items(), MIN_GAP_MS - 1);
    expect(calls.length).toBe(0);
    await s.update(items(), MIN_GAP_MS);
    expect(calls.length).toBe(1);
    expect(s.sortingFor(items()).by).toStartWith("model");
  });

  test("a failed call is tried again for the same items after a minute, then not again", async () => {
    let fail = true;
    const calls: number[] = [];
    const s = new Sorter({
      key: async () => "k",
      chat: async () => {
        calls.push(1);
        if (fail) throw new Error("timed out");
        return answerFor();
      },
    });
    await s.update(items(), 0);
    fail = false;
    await s.update(items(), MIN_GAP_MS);
    expect(calls.length).toBe(2);
    expect(s.sortingFor(items()).by).toStartWith("model");
    await s.update(items(), MIN_GAP_MS * 3);
    expect(calls.length).toBe(2);
  });
});

describe("reading the model's answer", () => {
  test("two sessions sharing their first 8 characters keep their own answers", () => {
    const twins = [
      item({ id: "abcdabcd-1111-4000-8000-000000000000" }),
      item({ id: "abcdabcd-2222-4000-8000-000000000000" }),
    ];
    const answer = JSON.stringify({
      themes: [
        { id: "t1", name: "One", sub: "" },
        { id: "t2", name: "Two", sub: "" },
      ],
      items: twins.map((twin, i) => ({
        id: shortIds(twins).get(twin.id),
        theme: `t${i + 1}`,
        lines: [],
      })),
    });
    const sorting = parseAnswer(answer, twins, "m");
    expect(sorting?.themeOf[twins[0]?.id ?? ""]).toBe("t1");
    expect(sorting?.themeOf[twins[1]?.id ?? ""]).toBe("t2");
  });

  test("a valid answer gives themes, lines and related links by full id", () => {
    const sorting = parseAnswer(answerFor(), items(), "m");
    expect(sorting?.themes.map((t) => t.name)).toEqual(["Shop", "Books"]);
    expect(sorting?.themeOf["c:gmail_search:t1"]).toBe("t1");
    expect(sorting?.lines[A]?.[1]?.length).toBeLessThanOrEqual(23);
    expect(sorting?.related).toEqual([{ a: A, b: "c:gmail_search:t1", label: "about" }]);
  });

  test("an answer in a fence with words round it still reads", () => {
    const sorting = parseAnswer(
      `Here you go:\n\`\`\`json\n${answerFor()}\n\`\`\`\nDone.`,
      items(),
      "m",
    );
    expect(sorting?.themeOf[B]).toBe("t2");
  });

  test("not JSON, the wrong shape, or most items unthemed is no answer", () => {
    expect(parseAnswer("I cannot help with that", items(), "m")).toBeNull();
    expect(parseAnswer(JSON.stringify({ themes: [], items: [] }), items(), "m")).toBeNull();
    const few = JSON.parse(answerFor());
    few.items = few.items.slice(0, 1);
    expect(parseAnswer(JSON.stringify(few), items(), "m")).toBeNull();
  });

  test("unknown ids and themes are dropped, not trusted", () => {
    const odd = JSON.parse(answerFor());
    odd.items.push({ id: "zzzzzzzz", theme: "t1", lines: [] });
    odd.related.push({ a: "zzzzzzzz", b: "c1", label: "x" });
    const sorting = parseAnswer(JSON.stringify(odd), items(), "m");
    expect(Object.keys(sorting?.themeOf ?? {})).toHaveLength(3);
    expect(sorting?.related).toHaveLength(1);
  });
});

describe("the fallback", () => {
  test("summaries come from brief lines, or none beside the title", () => {
    const sorting = fallbackSorting(items());
    expect(sorting.lines[A]).toEqual(["Tests pass", "Ship it"]);
    expect(sorting.lines[B]).toEqual([]);
  });

  test("keeps at most 9 themes, the rest under Other", () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ id: `s${i}`, repo: `repo${i}` }));
    const sorting = fallbackSorting(many);
    expect(sorting.themes).toHaveLength(9);
    expect(sorting.themes.at(-1)?.name).toBe("Other");
  });
});
