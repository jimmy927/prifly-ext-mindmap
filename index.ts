/**
 * Mind map: a live radial map of the reader's prifly sessions, the
 * conversations they are about and their Trello cards, in a panel of its own
 * ("Mind map" in the status bar). The page asks `api/map` while it is
 * visible; everything is worked out here and the page only draws it. A click
 * on a link goes to `api/open`, which opens it in the reader's browser.
 * "Move to theme…" in a circle's menu goes to `api/move`, which keeps where
 * the reader put it.
 */

import type { ExtensionApi, PanelRequest } from "@prifly/extension-api";
import { MindMap } from "./mindmap";

let map: MindMap | null = null;

export function activate(api: ExtensionApi): () => void {
  const current = new MindMap(api);
  map = current;
  void current.load().catch((error: unknown) => {
    api.log("load_failed", { error: error instanceof Error ? error.message : String(error) });
  });
  return () => {
    if (map === current) map = null;
  };
}

export function panel(_panelId: string, request: PanelRequest): unknown {
  const current = map;
  if (current === null) throw new Error("Mind map is not running.");
  if (request.path === "open") return current.open(request.body);
  if (request.path === "move") return current.move(request.body, Date.now());
  if (request.path !== "map") throw new Error(`No such request: ${request.path}`);
  return current.view(Date.now());
}
