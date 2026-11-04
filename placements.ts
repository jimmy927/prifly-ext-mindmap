/**
 * The reader's own placements ("Move to theme…" in a circle's right-click
 * menu): item id → the area (by name) and sub-topic the reader put it under,
 * kept in `api.state` so they survive a regroup and a restart. The model never
 * overrides one; the latest go to it as examples, so similar new items follow.
 * A placement under an area the setting no longer has is kept but not used.
 */

import type { ExtensionStateApi } from "@prifly/extension-api";
import { type Area, areaNamed } from "./areas";
import { type Example, MAX_EXAMPLES } from "./placing";

const STATE_NAME = "placements";
/** The most placements kept; the oldest go first. */
const KEEP = 500;

export type Placement = { area: string; sub: string; title: string; at: number };
type Kept = Record<string, Placement>;

export class Placements {
  private kept: Kept = {};
  private readonly state: ExtensionStateApi | undefined;

  constructor(state: ExtensionStateApi | undefined) {
    this.state = state;
  }

  async load(): Promise<void> {
    const saved = await this.state?.get<Kept>(STATE_NAME).catch(() => undefined);
    if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) this.kept = saved;
  }

  /** Where the reader put `id`, when that area is one of `areas` now. */
  of(id: string, areas: readonly Area[]): { area: Area; sub: string } | undefined {
    const placement = this.kept[id];
    const area = placement === undefined ? undefined : areaNamed(areas, placement.area);
    return area === undefined || placement === undefined ? undefined : { area, sub: placement.sub };
  }

  /** Puts `id` under `area` / `sub`, and keeps it. */
  async set(id: string, placement: Placement): Promise<void> {
    this.kept[id] = placement;
    const all = Object.entries(this.kept).sort(([, a], [, b]) => b.at - a.at);
    if (all.length > KEEP) this.kept = Object.fromEntries(all.slice(0, KEEP));
    await this.save();
  }

  /** Forgets the reader's placement of `id`: the model places it again. */
  async reset(id: string): Promise<void> {
    if (this.kept[id] === undefined) return;
    delete this.kept[id];
    await this.save();
  }

  /** The latest placements under one of `areas`, as examples for the model. */
  examples(areas: readonly Area[]): Example[] {
    return Object.values(this.kept)
      .sort((a, b) => b.at - a.at)
      .flatMap((p) => {
        const area = areaNamed(areas, p.area);
        return area === undefined ? [] : [{ title: p.title, area: area.name, sub: p.sub }];
      })
      .slice(0, MAX_EXAMPLES);
  }

  private async save(): Promise<void> {
    await this.state?.set(STATE_NAME, this.kept).catch(() => undefined);
  }
}
