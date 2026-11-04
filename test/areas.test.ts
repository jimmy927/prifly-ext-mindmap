import { describe, expect, test } from "bun:test";
import manifest from "../prifly-extension.json";
import { areaId, DEFAULT_AREAS, DEFAULT_AREAS_TEXT, OTHER, parseAreas } from "../areas";
import type { LlmRequest } from "../llm";
import { type MapAnswer, MindMap } from "../mindmap";
import { exampleLine, parsePlacing, placingRequest } from "../placing";
import type { FactSession } from "../types";
import { fakeApi, groupingCalls, isLines, item, linesText, model, session } from "./fake";

const NOW = Date.parse("2026-11-04T09:00:00Z");

type SentPlacing = {
  areas: { name: string; hint?: string }[];
  items: { id: string; title: string }[];
  readerPlacements: string[];
  previousSubs: { area: string; sub: string; members: string[] }[];
};

const sentOf = (request: LlmRequest) => JSON.parse(request.prompt) as SentPlacing;

/** Where an invented model puts an item, by its title. */
type Rule = (title: string) => { area: string; sub: string };

/** By default: Teamtailor things under partners, invoices under finance, the rest nowhere known. */
const RULE: Rule = (title) => {
  if (/teamtailor/i.test(title)) return { area: "Partners & integrations", sub: "Teamtailor" };
  if (/invoice/i.test(title)) return { area: "Finance", sub: "Invoices" };
  return { area: "Holidays", sub: "" };
};

function placingText(request: LlmRequest, rule: Rule): string {
  return JSON.stringify({
    items: sentOf(request).items.map((i) => ({ id: i.id, ...rule(i.title) })),
    related: [],
  });
}

function placer(rule: { current: Rule }) {
  return model((request) =>
    isLines(request) ? linesText(request) : placingText(request, rule.current),
  );
}

function sessions(): FactSession[] {
  const shape = { cwd: "/home/ada/src/odi", state: "working" as const };
  return [
    session({ ...shape, title: "Teamtailor webhook" }),
    session({ ...shape, title: "Teamtailor job sync" }),
    session({ ...shape, title: "Invoice run October" }),
    session({ ...shape, title: "Garden shed" }),
  ];
}

function setup(areas = DEFAULT_AREAS_TEXT) {
  const rule = { current: RULE };
  const fake = placer(rule);
  const api = fakeApi({ sessions: sessions(), ask: fake.ask, settings: { areas } });
  return { api, calls: fake.calls, rule, map: new MindMap(api) };
}

async function settled(map: MindMap, now: number): Promise<MapAnswer> {
  map.view(now);
  await map.settle();
  return map.view(now + 1000);
}

function mapOf(answer: MapAnswer) {
  if (answer.state !== "map") throw new Error(`expected a map, got ${JSON.stringify(answer)}`);
  return answer.map;
}

function themeOf(answer: MapAnswer, title: string): string | undefined {
  const view = mapOf(answer);
  const node = view.nodes.find((n) => n.title === title);
  return view.themes.find((t) => t.id === node?.theme)?.name;
}

describe("the areas setting", () => {
  test("one area per line or per ';', a name and an optional hint; blanks and repeats left out", () => {
    const areas = parseAreas(
      "ODI / Artemis product\n  Partners & integrations: Teamtailor, Jobylon ; ;\nfinance: Fortnox\nFinance\n",
    );
    expect(areas).toEqual([
      { id: areaId("ODI / Artemis product"), name: "ODI / Artemis product", hint: "" },
      {
        id: areaId("Partners & integrations"),
        name: "Partners & integrations",
        hint: "Teamtailor, Jobylon",
      },
      { id: areaId("finance"), name: "finance", hint: "Fortnox" },
    ]);
    expect(parseAreas("   \n ; ")).toEqual([]);
  });

  test("the manifest's default is the six default areas", () => {
    const field = manifest.settings.find((s) => s.id === "areas");
    expect(field?.default).toBe(DEFAULT_AREAS_TEXT);
    expect(parseAreas(DEFAULT_AREAS_TEXT).map((a) => a.name)).toEqual([
      "ODI / Artemis product",
      "Partners & integrations",
      "prifly",
      "Proxy & datamining",
      "Finance",
      "Family & friends",
    ]);
    expect(DEFAULT_AREAS).toHaveLength(6);
  });
});

describe("the placing call", () => {
  const areas = parseAreas(DEFAULT_AREAS_TEXT);
  const items = sessions().map((s) => item({ id: s.id, title: s.title, repo: "odi" }));

  test("sends the areas with their hints and forbids new top-level themes", () => {
    const request = placingRequest(items, areas, { shared: [], previous: [], examples: [] });
    expect(request.tier).toBe("fast");
    expect(sentOf(request).areas[1]).toEqual({
      name: "Partners & integrations",
      hint: "Teamtailor, Jobylon, Intelliplan, Eltel",
    });
    expect(sentOf(request).areas[0]).toEqual({ name: "ODI / Artemis product" });
    expect(request.system).toContain("Never invent a new top-level theme");
    expect(request.system).toContain('"Other"');
    expect(request.system).toContain("never by the service it came from");
  });

  test("an answer naming an unknown area puts the item under Other; a known one is matched loosely", () => {
    const text = JSON.stringify({
      items: [
        { id: "i1", area: "partners & INTEGRATIONS", sub: "Teamtailor" },
        { id: "i2", area: "Holidays", sub: "" },
      ],
      related: [],
    });
    const { placing, problems } = parsePlacing(text, items.slice(0, 2), areas);
    expect(problems).toEqual([]);
    expect(placing?.areaOf.get(items[0]?.id ?? "")).toBe(areaId("Partners & integrations"));
    expect(placing?.areaOf.get(items[1]?.id ?? "")).toBe(OTHER.id);
  });

  test("a catch-all or service sub-topic is a reason to ask again, and is dropped", () => {
    const text = JSON.stringify({
      items: [
        { id: "i1", area: "Finance", sub: "Misc" },
        { id: "i2", area: "Finance", sub: "WhatsApp" },
        { id: "i3", area: "Finance", sub: "Finance" },
      ],
      related: [],
    });
    const { placing, problems } = parsePlacing(text, items.slice(0, 3), areas);
    expect(problems.join(" | ")).toContain('"Misc" is a catch-all');
    expect(problems.join(" | ")).toContain('"WhatsApp" is a service');
    expect(problems.join(" | ")).toContain("repeats its area's name");
    expect(placing?.subOf.size).toBe(0);
  });
});

describe("the map with areas", () => {
  test("the themes are the areas in the reader's order, each with its colour; Other only when used", async () => {
    const { map, calls } = setup();
    const answer = await settled(map, NOW);
    const view = mapOf(answer);
    expect(view.themes.map((t) => t.name)).toEqual([
      ...parseAreas(DEFAULT_AREAS_TEXT).map((a) => a.name),
      "Other",
    ]);
    expect(new Set(view.themes.map((t) => t.color)).size).toBe(7);
    expect(themeOf(answer, "Garden shed")).toBe("Other");
    // Two Teamtailor items share a sub-topic: a hub of their own inside the area.
    expect(view.subs?.map((s) => s.name)).toEqual(["Teamtailor"]);
    expect(view.nodes.filter((n) => n.hub !== undefined).map((n) => n.title)).toEqual([
      "Teamtailor webhook",
      "Teamtailor job sync",
    ]);
    expect(view.areas?.find((a) => a.name === "Finance")?.subs).toEqual(["Invoices"]);
    expect(groupingCalls(calls)).toHaveLength(1);

    // Nothing left under Other: it is not on the map.
    const all = await settled(setup("Garden: shed\nFinance").map, NOW);
    expect(mapOf(all).themes.map((t) => t.name)).toEqual(["Garden", "Finance", "Other"]);
  });

  test("no circle overlaps another, hubs included", async () => {
    const view = mapOf(await settled(setup().map, NOW));
    const circles = [view.root, ...view.themes, ...(view.subs ?? []), ...view.nodes];
    for (let i = 0; i < circles.length; i++)
      for (let j = i + 1; j < circles.length; j++) {
        const a = circles[i];
        const b = circles[j];
        if (a === undefined || b === undefined) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
      }
  });

  test("a manual move wins over the model, survives a regroup and a restart, and goes as an example", async () => {
    const { api, map, calls, rule } = setup();
    const first = await settled(map, NOW);
    const shed = mapOf(first).nodes.find((n) => n.title === "Garden shed");
    const family = areaId("Family & friends");
    const moved = await map.move({ id: shed?.id, area: family, sub: "Home" }, NOW + 2000);
    expect(themeOf(moved, "Garden shed")).toBe("Family & friends");
    expect(mapOf(moved).nodes.find((n) => n.title === "Garden shed")).toMatchObject({
      sub: "Home",
      manual: true,
    });
    // Other held only the shed: it is gone.
    expect(mapOf(moved).themes.map((t) => t.name)).not.toContain("Other");

    // A regroup (new areas order) puts it elsewhere by the model; the move stands.
    rule.current = (title) => ({ area: "Finance", sub: title.slice(0, 4) });
    api.changeSettings({ areas: `Family & friends; ${DEFAULT_AREAS_TEXT}` });
    await map.settle();
    const regrouped = map.view(NOW + 3000);
    expect(groupingCalls(calls)).toHaveLength(2);
    expect(themeOf(regrouped, "Teamtailor webhook")).toBe("Finance");
    expect(themeOf(regrouped, "Garden shed")).toBe("Family & friends");
    expect(sentOf(groupingCalls(calls)[1] as LlmRequest).readerPlacements).toEqual([
      exampleLine({ title: "Garden shed", area: "Family & friends", sub: "Home" }),
    ]);

    // A restart on the same state.
    await new Promise((done) => setTimeout(done, 0));
    const again = new MindMap(api);
    await again.load();
    expect(themeOf(await settled(again, NOW + 4000), "Garden shed")).toBe("Family & friends");
  });

  test("reset gives the item back to the model", async () => {
    const { map } = setup();
    const first = await settled(map, NOW);
    const id = mapOf(first).nodes.find((n) => n.title === "Garden shed")?.id;
    await map.move({ id, area: areaId("Finance"), sub: "" }, NOW + 2000);
    const reset = await map.move({ id, reset: true }, NOW + 3000);
    expect(themeOf(reset, "Garden shed")).toBe("Other");
    expect(mapOf(reset).nodes.find((n) => n.title === "Garden shed")?.manual).toBeUndefined();
    expect(map.placements.examples(parseAreas(DEFAULT_AREAS_TEXT))).toEqual([]);
  });

  test("a move to something that is no area, or of an item not on the map, is refused", async () => {
    const { map } = setup();
    const first = await settled(map, NOW);
    const id = mapOf(first).nodes[0]?.id;
    await expect(map.move({ id, area: "a:holidays" }, NOW)).rejects.toThrow(
      "not one of your areas",
    );
    await expect(map.move({ id: "nope", area: areaId("Finance") }, NOW)).rejects.toThrow(
      "not on the map",
    );
  });

  test("a setting change regroups at once, not a minute later", async () => {
    const { api, map, calls } = setup();
    await settled(map, NOW);
    api.changeSettings({ areas: "Partners & integrations: Teamtailor\nFinance: invoices" });
    await map.settle();
    expect(groupingCalls(calls)).toHaveLength(2);
    expect(sentOf(groupingCalls(calls)[1] as LlmRequest).areas.map((a) => a.name)).toEqual([
      "Partners & integrations",
      "Finance",
    ]);
    const view = mapOf(map.view(NOW + 1000));
    expect(view.themes.map((t) => t.name)).toEqual(["Partners & integrations", "Finance", "Other"]);
    // The same settings again change nothing.
    api.changeSettings({ areas: "Partners & integrations: Teamtailor\nFinance: invoices" });
    await map.settle();
    expect(groupingCalls(calls)).toHaveLength(2);
  });

  test("an empty setting keeps the model's own themes, and no Move to theme", async () => {
    const fake = model();
    const api = fakeApi({ sessions: sessions(), ask: fake.ask, settings: { areas: "  " } });
    const view = mapOf(await settled(new MindMap(api), NOW));
    expect(view.themes.map((t) => t.name)).toEqual(["Shop work"]);
    expect(view.areas).toBeUndefined();
    expect(view.subs).toEqual([]);
    expect(groupingCalls(fake.calls)[0]?.system).toContain("You group a person's");
  });
});
