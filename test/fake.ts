/** A fake `api` and invented items for the tests: no real prifly data, no network. */

import type { ExtensionApi, ExtensionStateApi, SettingValue } from "@prifly/extension-api";
import type { Ask, LlmFailCode, LlmRequest } from "../llm";
import type { FactSession, Item, ReadResult } from "../types";

export function fakeState(): ExtensionStateApi & { docs: Map<string, unknown> } {
  const docs = new Map<string, unknown>();
  const copy = <T>(value: T): T =>
    value === undefined ? value : JSON.parse(JSON.stringify(value));
  return {
    docs,
    get: async (name: string) => copy(docs.get(name)) as never,
    set: async (name, value) => {
      docs.set(name, copy(value));
    },
    update: async (name, fn) => {
      const next = await fn(copy(docs.get(name)) as never);
      docs.set(name, copy(next));
      return next;
    },
    delete: async (name) => docs.delete(name),
    list: async () => [...docs.keys()].sort(),
    importOnce: async () => undefined,
    append: async () => 0,
    read: async () => [],
  };
}

export type FakeOptions = {
  sessions?: FactSession[];
  features?: string[];
  /** The model call prifly lends; null or absent for a prifly without "llm-ask". Read at each use. */
  ask?: Ask | null;
  read?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** The browser prifly opens links in (feature "open-url"); absent for a prifly without it. */
  open?: (url: string) => Promise<boolean>;
  /** The extension's settings (feature "settings"); absent for a prifly without them. */
  settings?: Record<string, SettingValue>;
};

/** What the fake api adds for the tests: its log, its reads, and the reader editing a setting. */
export type FakeApi = ExtensionApi & {
  logs: string[];
  reads: string[];
  changeSettings: (values: Record<string, SettingValue>) => void;
};

/** What the grouping prompt carries, as the tests read it. */
export type Sent = {
  items: { id: string; kind: string; title: string; repo: string; [field: string]: unknown }[];
  sharedEntities?: { a: string; b: string; label: string }[];
  previousTopics: { id: string; name: string; sub: string; members: string[] }[];
};

export function sentIn(request: LlmRequest): Sent {
  return JSON.parse(request.prompt) as Sent;
}

/** A well-formed grouping answer: every item in the one topic `t1`. */
export function goodText(request: LlmRequest, name = "Shop work"): string {
  return JSON.stringify({
    topics: [{ id: "t1", name, sub: "named by the model" }],
    items: sentIn(request).items.map((i) => ({ id: i.id, topic: "t1" })),
    related: [],
  });
}

/** Whether `request` asks for summary lines (a batch) and not for the grouping. */
export function isLines(request: LlmRequest): boolean {
  return sentIn(request).sharedEntities === undefined;
}

/** A well-formed answer to a batch of lines: two lines each. */
export function linesText(request: LlmRequest): string {
  return JSON.stringify({
    items: sentIn(request).items.map((i) => ({ id: i.id, lines: ["line one", "line two"] })),
  });
}

/** The calls that asked for the grouping, and those that asked for lines. */
export function groupingCalls(calls: readonly LlmRequest[]): LlmRequest[] {
  return calls.filter((request) => !isLines(request));
}
export function lineCalls(calls: readonly LlmRequest[]): LlmRequest[] {
  return calls.filter(isLines);
}

/** A model that answers every call with `text(request, call number)` (the grouping and the lines by default), counting the calls. */
export function model(
  text: (request: LlmRequest, call: number) => string = (request) =>
    isLines(request) ? linesText(request) : goodText(request),
): { ask: Ask; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const ask: Ask = async (request) => {
    calls.push(request);
    return {
      ok: true,
      text: text(request, calls.length),
      model: "claude-haiku",
      backend: "claude",
    };
  };
  return { ask, calls };
}

/** A model that refuses every call. */
export function refusing(code: LlmFailCode, reason: string): Ask {
  return async () => ({ ok: false, code, reason });
}

export function fakeApi(options: FakeOptions = {}): FakeApi {
  const logs: string[] = [];
  const reads: string[] = [];
  let onSettings: ((values: Record<string, SettingValue>) => void) | null = null;
  const tools = {
    register: () => undefined,
    // As prifly answers: { ok, text } or { ok: false, error }, never a throw.
    read: async (name: string, args: Record<string, unknown>): Promise<ReadResult> => {
      reads.push(name);
      if (options.read === undefined) return { ok: false, error: `no such tool: ${name}` };
      try {
        return { ok: true, text: await options.read(name, args) };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  };
  const api = {
    logs,
    reads,
    get features() {
      return (
        options.features ?? [
          "state",
          ...(options.ask ? ["llm-ask"] : []),
          ...(options.open ? ["open-url"] : []),
          ...(options.settings ? ["settings"] : []),
        ]
      );
    },
    get settings() {
      return options.settings;
    },
    onSettings: (handler: (values: Record<string, SettingValue>) => void) => {
      onSettings = handler;
    },
    changeSettings: (values: Record<string, SettingValue>) => {
      options.settings = values;
      onSettings?.(values);
    },
    openUrl: options.open,
    llm: { ask: (request: LlmRequest) => (options.ask ?? refusing("no-model", "none"))(request) },
    tools,
    state: fakeState(),
    sessions: () => options.sessions ?? [],
    log: (event: string) => {
      logs.push(event);
    },
  };
  return api as unknown as FakeApi;
}

let counter = 0;

/** An invented session; ids are hex so prefixes match like prifly's. */
export function session(fields: Partial<FactSession> = {}): FactSession {
  counter += 1;
  const id = `${counter.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return {
    id,
    title: `task ${counter}`,
    cwd: "/home/ada/src/widgets",
    state: "working",
    ...fields,
  };
}

export function item(fields: Partial<Item> & { id: string }): Item {
  return {
    kind: "session",
    title: fields.id,
    repo: "widgets",
    brief: [],
    status: "idle",
    ...fields,
  };
}
