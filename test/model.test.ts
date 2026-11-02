import { describe, expect, test } from "bun:test";
import { entitiesOf } from "../entities";
import { type Chat, MIN_GAP_MS, MODEL, Namer, type TopicInfo } from "../model";
import { parseNaming } from "../sorting";
import { fakeState, item } from "./fake";

const S = "aaaaaaaa-1111-4000-8000-000000000000";

function members() {
  return [
    item({ id: S, title: "Reply to Ada about the refund", repo: "shop", brief: ["Draft ready"] }),
    item({
      id: "c:whatsapp_chats:ada",
      kind: "conversation",
      title: "Ada Lovelace",
      name: "Ada Lovelace",
      repo: "WhatsApp",
      head: "Did the refund go through?",
    }),
    item({
      id: "c:gmail_search:t1",
      kind: "conversation",
      title: "Ada Lovelace",
      name: "Ada Lovelace",
      repo: "Gmail",
      subject: "Refund for order 1042",
    }),
  ];
}

const topic = (list = members()): TopicInfo => ({ id: "t1", members: list, pairs: [] });

/** A namer's answer, as the model would give it for `members()`. */
function goodAnswer(name = "Ada's refund"): string {
  return JSON.stringify({
    name,
    sub: "a customer's money back",
    items: [
      { id: "i1", lines: ["Reply drafted", "Waiting on you to send it"] },
      { id: "i2", lines: ["Ada asks", "about the refund"] },
      { id: "i3", lines: ["Order 1042", "refund request"] },
    ],
    pairs: [],
  });
}

function namer(answer: () => string, key: string | null = "k") {
  const calls: string[] = [];
  const chat: Chat = async (_key, model, messages) => {
    calls.push(model);
    expect(messages[1]?.content ?? "").not.toContain("WhatsApp");
    return answer();
  };
  const state = fakeState();
  return { namer: new Namer({ key: async () => key, chat, state }), calls, state };
}

describe("the namer", () => {
  test("names a topic once with Gemma, parsed with zod, and keeps it in api.state", async () => {
    const { namer: n, calls, state } = namer(() => goodAnswer());
    const entities = entitiesOf(members());
    await n.update([topic()], entities, 0);
    await n.update([topic()], entities, MIN_GAP_MS * 5);
    expect(calls).toEqual([MODEL]);
    expect(MODEL).toBe("google/gemma-4-26B-A4B-it");
    expect(n.themeOf(topic(), entities)).toMatchObject({ id: "t1", name: "Ada's refund" });
    expect(n.linesOf(members()[1] ?? item({ id: "x" }))).toEqual(["Ada asks", "about the refund"]);
    expect(state.docs.has("names")).toBe(true);
    expect(n.state()).toBe("model");
  });

  test("a bad answer falls back to the entity the members share", async () => {
    const { namer: n } = namer(() => "Sorry, I cannot help with that.");
    const entities = entitiesOf(members());
    await n.update([topic()], entities, 0);
    expect(n.themeOf(topic(), entities).name).toBe("Ada");
    expect(n.state()).toBe("failed");
    // Lines fall back to the brief, or the subject and head.
    expect(n.linesOf(members()[0] ?? item({ id: "x" }))).toEqual(["Draft ready"]);
  });

  test("a name that is only a service's is no answer", () => {
    expect(parseNaming(goodAnswer("WhatsApp"), members())).toBeNull();
  });

  test("a garbled name key still reads; unknown ids are dropped", () => {
    const answer = JSON.parse(goodAnswer());
    answer["name la"] = answer.name;
    delete answer.name;
    answer.items.push({ id: "i9", lines: ["nobody"] });
    const naming = parseNaming(JSON.stringify(answer), members());
    expect(naming?.name).toBe("Ada's refund");
    expect(naming?.lines.size).toBe(3);
  });

  test("keeps the name while members barely change; asks again only for a change, once a minute", async () => {
    let name = "Ada's refund";
    const { namer: n, calls } = namer(() => goodAnswer(name));
    const entities = entitiesOf(members());
    await n.update([topic()], entities, 0);
    name = "Something else";
    const more = [...members(), item({ id: "bbbbbbbb-2222-4000-8000-000000000000", title: "x" })];
    await n.update([topic(more)], entitiesOf(more), MIN_GAP_MS - 1);
    expect(calls).toHaveLength(1);
    await n.update([topic(more)], entitiesOf(more), MIN_GAP_MS);
    expect(calls).toHaveLength(2);
    expect(n.themeOf(topic(more), entitiesOf(more)).name).toBe("Ada's refund");
  });

  test("with no key it never calls, and names by entities", async () => {
    const { namer: n, calls } = namer(() => goodAnswer(), null);
    const entities = entitiesOf(members());
    await n.update([topic()], entities, 0);
    expect(calls).toHaveLength(0);
    expect(n.state()).toBe("no key");
    expect(n.themeOf(topic(), entities).name).toBe("Ada");
  });

  test("a key added later is used for the same topic after a minute", async () => {
    let key: string | null = null;
    const calls: number[] = [];
    const n = new Namer({
      key: async () => key,
      chat: async () => {
        calls.push(1);
        return goodAnswer();
      },
    });
    const entities = entitiesOf(members());
    await n.update([topic()], entities, 0);
    key = "k";
    await n.update([topic()], entities, MIN_GAP_MS - 1);
    expect(calls).toHaveLength(0);
    await n.update([topic()], entities, MIN_GAP_MS);
    expect(calls).toHaveLength(1);
    expect(n.themeOf(topic(), entities).name).toBe("Ada's refund");
  });

  test("a failed call is tried again after a minute, then not again", async () => {
    let fail = true;
    const calls: number[] = [];
    const n = new Namer({
      key: async () => "k",
      chat: async () => {
        calls.push(1);
        if (fail) throw new Error("timed out");
        return goodAnswer();
      },
    });
    const entities = entitiesOf(members());
    await n.update([topic()], entities, 0);
    expect(n.state()).toBe("failed");
    fail = false;
    await n.update([topic()], entities, MIN_GAP_MS - 1);
    expect(calls).toHaveLength(1);
    await n.update([topic()], entities, MIN_GAP_MS);
    expect(calls).toHaveLength(2);
    expect(n.state()).toBe("model");
    await n.update([topic()], entities, MIN_GAP_MS * 3);
    expect(calls).toHaveLength(2);
  });

  test("one failed topic of two keeps the footer on the model; the other is named", async () => {
    const other = [item({ id: "bbbbbbbb-2222-4000-8000-000000000000", title: "Tax report" })];
    const n = new Namer({
      key: async () => "k",
      chat: async (_key, _model, messages) => {
        if ((messages[1]?.content ?? "").includes("Tax report")) throw new Error("HTTP 500");
        return goodAnswer();
      },
    });
    const all = [...members(), ...other];
    const second: TopicInfo = { id: "t2", members: other, pairs: [] };
    await n.update([topic(), second], entitiesOf(all), 0);
    expect(n.state()).toBe("model");
    expect(n.themeOf(topic(), entitiesOf(all)).name).toBe("Ada's refund");
  });

  test("a restart reads the kept names and does not ask again", async () => {
    const first = namer(() => goodAnswer());
    const entities = entitiesOf(members());
    await first.namer.update([topic()], entities, 0);
    const calls: number[] = [];
    const again = new Namer({
      key: async () => "k",
      chat: async () => {
        calls.push(1);
        return goodAnswer();
      },
      state: first.state,
    });
    await again.load();
    await again.update([topic()], entities, MIN_GAP_MS * 10);
    expect(calls).toHaveLength(0);
    expect(again.themeOf(topic(), entities).name).toBe("Ada's refund");
  });
});
