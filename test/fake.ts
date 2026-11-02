/** A fake `api` and invented items for the tests: no real prifly data, no network. */

import type { ExtensionApi, ExtensionStateApi } from "@prifly/extension-api";
import type { FactSession, Item } from "../types";

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
  key?: string | null;
  read?: (name: string, args: Record<string, unknown>) => Promise<string>;
};

export function fakeApi(
  options: FakeOptions = {},
): ExtensionApi & { logs: string[]; reads: string[] } {
  const logs: string[] = [];
  const reads: string[] = [];
  const tools = {
    register: () => undefined,
    read: async (name: string, args: Record<string, unknown>) => {
      reads.push(name);
      if (options.read === undefined) throw new Error(`no such tool: ${name}`);
      return options.read(name, args);
    },
  };
  const api = {
    logs,
    reads,
    features: options.features ?? ["state"],
    vault: { read: async (name: string) => (name === "deepinfra" ? (options.key ?? null) : null) },
    tools,
    state: fakeState(),
    sessions: () => options.sessions ?? [],
    log: (event: string) => {
      logs.push(event);
    },
  };
  return api as unknown as ExtensionApi & { logs: string[]; reads: string[] };
}

let counter = 0;

/** An invented session; ids are hex so prefixes match like prifly's. */
export function session(fields: Partial<FactSession> = {}): FactSession {
  counter += 1;
  const id = `${counter.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return { id, title: `task ${counter}`, cwd: "/home/ada/src/widgets", state: "idle", ...fields };
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
