/**
 * The reader's areas: the map's top-level themes, in the reader's own
 * structure, from the "Areas" setting (prifly's Extensions dialog). One area
 * per line — or per ";", since the dialog's text field is a single line — each
 * a name, optionally followed by ":" and a few words of hint for the model:
 * "Partners & integrations: Teamtailor, Jobylon, Intelliplan, Eltel". An empty
 * setting, or a prifly without settings, means no areas: the model invents the
 * themes as before.
 */

import type { ExtensionApi, SettingValues } from "@prifly/extension-api";
import { normalise } from "./rules";

export type Area = { id: string; name: string; hint: string };

/** The id of a setting in the manifest's `settings`. */
export const AREAS_SETTING = "areas";
export const SETTINGS_FEATURE = "settings";

/** Where an item that fits no area goes; on the map only while it holds something. */
export const OTHER: Area = { id: "other", name: "Other", hint: "" };

export const DEFAULT_AREAS: readonly string[] = [
  "ODI / Artemis product",
  "Partners & integrations: Teamtailor, Jobylon, Intelliplan, Eltel",
  "prifly: prifly and its extensions",
  "Proxy & datamining",
  "Finance: Fortnox, Pleo, bokföring, invoices",
  "Family & friends",
];

/** The setting's default text: the areas joined by "; ". */
export const DEFAULT_AREAS_TEXT = DEFAULT_AREAS.join("; ");

const NAME_CHARS = 40;
const HINT_CHARS = 120;
/** The most areas a map has (each keeps a colour of its own up to the palette's nine). */
export const MAX_AREAS = 12;

/** An area's id: its name, normalised, so it is the same on every read of the setting. */
export function areaId(name: string): string {
  return `a:${normalise(name)}`;
}

/** The areas in `text`, in its order; blank lines, repeated names and "Other" (the map's own) left out. */
export function parseAreas(text: string): Area[] {
  const out: Area[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/[\n;]+/)) {
    const at = line.indexOf(":");
    const name = (at === -1 ? line : line.slice(0, at)).replace(/\s+/g, " ").trim();
    const hint =
      at === -1
        ? ""
        : line
            .slice(at + 1)
            .replace(/\s+/g, " ")
            .trim();
    const id = areaId(name);
    if (normalise(name) === "" || seen.has(id) || id === areaId(OTHER.name)) continue;
    seen.add(id);
    out.push({ id, name: name.slice(0, NAME_CHARS), hint: hint.slice(0, HINT_CHARS) });
    if (out.length === MAX_AREAS) break;
  }
  return out;
}

/** The areas in a settings answer; none when it has no "areas" text. */
export function areasIn(values: SettingValues | undefined): Area[] {
  const text = values?.[AREAS_SETTING];
  return typeof text === "string" ? parseAreas(text) : [];
}

/** The areas now: none where this prifly has no settings (feature "settings"). */
export function areasOf(api: ExtensionApi): Area[] {
  if (!(api.features ?? []).includes(SETTINGS_FEATURE)) return [];
  return areasIn(api.settings);
}

/** What changes the grouping in the areas: their names and hints, in order. "" for none. */
export function areasKey(areas: readonly Area[]): string {
  return areas.length === 0 ? "" : JSON.stringify(areas.map((a) => [a.name, a.hint]));
}

/** The area `name` names (case, accents and punctuation aside), or undefined. */
export function areaNamed(areas: readonly Area[], name: string): Area | undefined {
  const id = areaId(name);
  return areas.find((area) => area.id === id);
}
