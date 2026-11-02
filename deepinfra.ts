/**
 * What the map says when DeepInfra cannot be used: a call that failed with
 * its HTTP status and a short message, or no key in the vault. The map is
 * never grouped or named without DeepInfra, so these are shown instead.
 */

/** Which of the two calls failed. */
export type Call = "embedding" | "naming";

export const NO_KEY_TEXT =
  "No DeepInfra key in the vault (an api-token entry named deepinfra or deepinfra-api, at level 1)";

/** A failed DeepInfra call: its HTTP status and the short message from its answer. */
export class DeepInfraError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`DeepInfra answered ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.status = status;
    this.detail = detail;
  }
}

function messageIn(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (depth > 2 || typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const found = messageIn(record[key], depth + 1);
    if (found !== "") return found;
  }
  return "";
}

/** The message of an error body ({"detail":..}, {"error":{"message":..}} or plain text), on one short line. */
export function shortMessage(body: string): string {
  let text = body;
  try {
    text = messageIn(JSON.parse(body)) || body;
  } catch {
    // Not JSON: the body is the message.
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** The error for a response that was not ok. */
export async function failedResponse(response: Response): Promise<DeepInfraError> {
  const body = await response.text().catch(() => "");
  return new DeepInfraError(response.status, shortMessage(body));
}

/** What the page is told: enough to say why there is no (new) map. */
export type Failure = {
  call: Call;
  kind: "no-key" | "http" | "other";
  /** The HTTP status, for kind "http". */
  status: number | null;
  /** A heading for the error page. */
  title: string;
  /** One sentence for the page and the footer. */
  text: string;
};

export function noKeyFailure(call: Call): Failure {
  return { call, kind: "no-key", status: null, title: "No DeepInfra key", text: NO_KEY_TEXT };
}

export function failureOf(call: Call, error: unknown): Failure {
  if (error instanceof DeepInfraError) {
    return {
      call,
      kind: "http",
      status: error.status,
      title: `DeepInfra answered ${error.status}`,
      text: `DeepInfra answered ${error.status} to the ${call} call: ${error.detail || "no message"}`,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    call,
    kind: "other",
    status: null,
    title: "DeepInfra did not answer",
    text: `The ${call} call to DeepInfra failed: ${message}`,
  };
}
