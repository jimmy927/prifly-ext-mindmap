/**
 * Embeddings: one vector per item, from its own words (title, brief lines,
 * name, subject, last message — never its service), through DeepInfra's
 * OpenAI-compatible embeddings endpoint. Vectors are cached by a hash of that
 * text in `api.state`, so only new or changed items are sent: one batched call
 * per refresh, at most once a minute.
 */

import { createHash } from "node:crypto";
import type { ExtensionStateApi } from "@prifly/extension-api";
import { wordsOf } from "./entities";
import type { Item } from "./types";

/** Multilingual (Swedish and English), small and cheap; reads up to 2,048 tokens. */
export const EMBED_MODEL = "google/embeddinggemma-300m";
export const EMBED_ENDPOINT = "https://api.deepinfra.com/v1/openai/embeddings";
/** Kept dimensions: EmbeddingGemma is trained to be cut to 512, 256 or 128 (Matryoshka), and the cache stays small. */
export const DIMS = 256;
/** EmbeddingGemma's prompt for texts meant to be clustered. */
const PROMPT = "task: clustering | query: ";
export const EMBED_GAP_MS = 60_000;
/** At most this many texts in one call; the rest wait for the next. */
const BATCH = 256;
/** Vectors kept in `api.state`, oldest dropped first. */
const KEEP = 800;
const TIMEOUT_MS = 60_000;
const STATE_NAME = "embeddings";

/** Vectors for `texts`, in their order. Throws on a failed call. */
export type Embed = (key: string, model: string, texts: string[]) => Promise<number[][]>;

export const deepInfraEmbed: Embed = async (key, model, texts) => {
  const response = await fetch(EMBED_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: texts.map((text) => `${PROMPT}${text}`),
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`DeepInfra answered ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as { data?: { index?: number; embedding?: unknown }[] };
  const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = data.map((row) => row.embedding);
  if (
    vectors.length !== texts.length ||
    !vectors.every((v) => Array.isArray(v) && v.every((x) => typeof x === "number"))
  ) {
    throw new Error("DeepInfra's answer had no vectors for every text");
  }
  return vectors as number[][];
};

/** The text an item is embedded by, at most 1000 characters. */
export function embedText(item: Item): string {
  return wordsOf(item).slice(0, 1000);
}

export function textHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** The first `dims` dimensions, scaled back to length 1 and rounded, so the cache stays small. */
export function shrink(vector: readonly number[], dims = DIMS): number[] {
  const cut = vector.slice(0, dims);
  const norm = Math.sqrt(cut.reduce((sum, x) => sum + x * x, 0)) || 1;
  return cut.map((x) => Math.round((x / norm) * 1e5) / 1e5);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export type EmbedStatus = "ok" | "no key" | "failed" | "waiting";

export type EmbedderDeps = {
  key: () => Promise<string | null>;
  embed: Embed;
  state?: ExtensionStateApi | undefined;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
  model?: string;
};

type Saved = { model: string; vectors: Record<string, number[]> };

export class Embedder {
  private vectors = new Map<string, number[]>();
  private askedAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private status: EmbedStatus = "waiting";
  /** Bumped whenever vectors are added, so what is worked out from them knows to redo it. */
  version = 0;
  readonly model: string;
  private readonly deps: EmbedderDeps;

  constructor(deps: EmbedderDeps) {
    this.deps = deps;
    this.model = deps.model ?? EMBED_MODEL;
  }

  async load(): Promise<void> {
    const saved = await this.deps.state?.get<Saved>(STATE_NAME).catch(() => undefined);
    if (saved?.model !== this.model || typeof saved.vectors !== "object") return;
    this.vectors = new Map(Object.entries(saved.vectors));
    if (this.vectors.size > 0) this.version += 1;
  }

  vectorOf(item: Item): number[] | undefined {
    return this.vectors.get(textHash(embedText(item)));
  }

  /** The texts with no vector yet, each once. */
  private missing(items: readonly Item[]): string[] {
    const texts = items.map(embedText).filter((text) => text !== "");
    return [...new Set(texts)].filter((text) => !this.vectors.has(textHash(text)));
  }

  /** Whether `update` would call now: some text has no vector, and a minute has passed since the last call. */
  due(items: readonly Item[], now: number): boolean {
    return !this.busy && now - this.askedAt >= EMBED_GAP_MS && this.missing(items).length > 0;
  }

  /** Embed the new or changed texts in one call, when due. */
  async update(items: readonly Item[], now: number): Promise<void> {
    if (!this.due(items, now)) return;
    this.busy = true;
    this.askedAt = now;
    try {
      const key = await this.deps.key();
      if (key === null || key === "") {
        this.status = "no key";
        return;
      }
      await this.call(key, this.missing(items).slice(0, BATCH));
    } finally {
      this.busy = false;
    }
  }

  private async call(key: string, texts: string[]): Promise<void> {
    const started = Date.now();
    try {
      const vectors = await this.deps.embed(key, this.model, texts);
      texts.forEach((text, i) => {
        const vector = vectors[i];
        if (vector !== undefined) this.vectors.set(textHash(text), shrink(vector));
      });
      this.status = "ok";
      this.version += 1;
      this.deps.log?.("embedded", { texts: texts.length, ms: Date.now() - started });
      await this.save();
    } catch (error) {
      this.status = "failed";
      this.deps.log?.("embed_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async save(): Promise<void> {
    const entries = [...this.vectors].slice(-KEEP);
    this.vectors = new Map(entries);
    const saved: Saved = { model: this.model, vectors: Object.fromEntries(entries) };
    await this.deps.state?.set(STATE_NAME, saved).catch(() => undefined);
  }

  /** "ok" once any vector is at hand, else why not. */
  state(): EmbedStatus {
    if (this.status === "waiting" && this.vectors.size > 0) return "ok";
    return this.status;
  }
}
