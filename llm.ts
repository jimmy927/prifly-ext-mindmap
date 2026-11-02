/**
 * prifly's generic model call for extensions ("llm-ask"), and what the map
 * says when it cannot be used. The published `@prifly/extension-api` does not
 * have these types yet, so they are written here, all optional: `api.llm` is
 * absent on a prifly without the feature.
 */

import type { ExtensionApi } from "@prifly/extension-api";

export const LLM_FEATURE = "llm-ask";

export type LlmTier = "fast" | "balanced" | "strong";
export type LlmBackend = "claude" | "codex" | "provider";
export type LlmFailCode = "no-model" | "not-allowed" | "capped" | "failed";

export type LlmRequest = {
  tier: LlmTier;
  system: string;
  prompt: string;
  /** A JSON Schema the answer's JSON follows. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
};

/** `reason` is one sentence for a person. */
export type LlmAnswer =
  | { ok: true; text: string; model: string; backend: LlmBackend }
  | { ok: false; code: LlmFailCode; reason: string };

export type Ask = (request: LlmRequest) => Promise<LlmAnswer>;

type WithLlm = ExtensionApi & { llm?: { ask?: Ask } };

/** `api.llm.ask` where this prifly has it (feature "llm-ask"), else null. */
export function askOf(api: ExtensionApi): Ask | null {
  if (!(api.features ?? []).includes(LLM_FEATURE)) return null;
  const llm = (api as WithLlm).llm;
  const ask = llm?.ask;
  if (llm === undefined || typeof ask !== "function") return null;
  return (request) => ask.call(llm, request);
}

/** What the page is told: enough to say why there is no (new) map. */
export type Failure = {
  code: "unsupported" | LlmFailCode | "bad-answer";
  /** A short label for the error page's chip. */
  chip: string;
  /** A heading for the error page. */
  title: string;
  /** One sentence for the page and the footer. */
  text: string;
};

export const UNSUPPORTED_TEXT = "This prifly cannot lend the map a model yet: update prifly.";

export function unsupportedFailure(): Failure {
  return {
    code: "unsupported",
    chip: "Update prifly",
    title: "prifly has no model to lend",
    text: UNSUPPORTED_TEXT,
  };
}

const KINDS: Record<LlmFailCode, { chip: string; title: string }> = {
  "no-model": { chip: "No model", title: "prifly has no model set" },
  "not-allowed": { chip: "Not allowed", title: "The map may not use the model" },
  capped: { chip: "Limit reached", title: "The model's limit is reached" },
  failed: { chip: "Call failed", title: "The model did not answer" },
};

/** A refused call, in prifly's own one-sentence reason. */
export function refusedFailure(code: LlmFailCode, reason: string): Failure {
  const kind = KINDS[code];
  return { code, chip: kind.chip, title: kind.title, text: reason };
}

export function badAnswerFailure(why: string): Failure {
  return {
    code: "bad-answer",
    chip: "Bad answer",
    title: "The model's answer could not be used",
    text: `The model's answer could not be used, even after asking once more: ${why}.`,
  };
}

/** "claude-haiku" from "anthropic/claude-haiku". */
export function shortModel(model: string): string {
  return model.split("/").at(-1) ?? model;
}

const BACKENDS: Record<LlmBackend, string> = {
  claude: "Claude",
  codex: "Codex",
  provider: "your provider",
};

/** "Topics by claude-haiku via Claude": which model made the topics. */
export function modelLine(model: string, backend: LlmBackend): string {
  return `Topics by ${shortModel(model)} via ${BACKENDS[backend] ?? backend}`;
}
