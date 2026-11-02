/**
 * Shared entities, without a model: the people, mail domains, phone numbers,
 * repositories, card names, ticket ids and rarer words each item names. Two
 * items that share one get a strong edge, labelled by what they share, so a
 * WhatsApp chat, a mail and a session about the same person or product meet
 * whatever service they came from. A service's own name is never an entity.
 */

import type { Item } from "./types";

export type EntityKind = "person" | "ticket" | "card" | "domain" | "repo" | "term";

export type Entity = { key: string; kind: EntityKind; label: string };

/** Two items that share entities: their weight, and the strongest one's label. */
export type EntityEdge = { a: string; b: string; weight: number; label: string };

/** How strongly sharing one entity of a kind ties two items. */
const WEIGHT: Record<EntityKind, number> = {
  person: 2,
  ticket: 2,
  card: 1.5,
  domain: 1.2,
  repo: 1,
  term: 0.6,
};
const RANK: EntityKind[] = ["person", "ticket", "card", "domain", "repo", "term"];

/** Services, and words every chat or mail has: never an entity. */
const SERVICES = [
  "whatsapp",
  "gmail",
  "outlook",
  "telegram",
  "instagram",
  "linkedin",
  "messenger",
  "trello",
];
const STOP = new Set([
  ...SERVICES,
  ..."about after again also before being could does done from have here into just like make more most much need only other over please should some such than thanks that their them then there these they this those through very want what when where which while will with would your yours".split(
    " ",
  ),
  ..."add adds added change changes check fix fixes fixed make move remove update updates use using run runs test tests work works new old next last first back today tomorrow yesterday week time thing things message messages mail email chat group image photo video audio sticker reply forwarded hello thank session sessions branch draft review".split(
    " ",
  ),
  ..."och att det som inte för med till från har kan ska vill den detta dessa eller men jag hej tack bara också efter innan över under mycket någon något".split(
    " ",
  ),
]);
/** Mail domains everyone shares: no entity of their own. */
const COMMON_DOMAINS = new Set([
  ..."gmail googlemail outlook hotmail live msn yahoo icloud me mac proton protonmail aol gmx mail".split(
    " ",
  ),
  ..."google github linkedin facebook instagram trello atlassian microsoft apple amazon notion slack zoom".split(
    " ",
  ),
]);
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** Words; a slug's hyphens and underscores split it ("feature-email-ada" is three words). */
const TOKEN_RE = /[\p{L}\p{N}]+(?:[.'][\p{L}\p{N}]+)*/gu;
const TICKET_RE = /\b(?:[A-Z][A-Z0-9]{1,9}-\d{1,6}|[a-z][a-z0-9]{2,20}-\d{2,6})\b/g;
const PHONE_RE = /\+?\d[\d\s-]{6,}\d/g;

/** Lower case, accents dropped: "Åsa" → "asa". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

type Token = { norm: string; capital: boolean; raw: string };

function tokens(text: string): Token[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => ({
    norm: fold(m[0]),
    capital: /^\p{Lu}/u.test(m[0]),
    raw: m[0],
  }));
}

/** The words an item is written in: title, brief lines, name, subject and last message — never its service. */
export function wordsOf(item: Item): string {
  const parts = [item.title, ...item.brief, item.name, item.subject, item.head];
  const kept = parts.filter((part): part is string => part !== undefined && part.trim() !== "");
  return [...new Set(kept)].join("\n");
}

/** The last 9 digits of a phone number, so +46 70… and 070… match. */
function phoneKey(digits: string): string | null {
  const only = digits.replace(/\D/g, "");
  return only.length >= 7 ? only.slice(-9) : null;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** "mail.acme.co.uk" → "acme"; null for mail domains everyone shares. */
export function domainOf(address: string): string | null {
  const host = address.split("@")[1]?.toLowerCase() ?? "";
  const parts = host.split(".").filter((part) => part !== "");
  if (parts.length < 2) return null;
  const tld = parts.length >= 3 && SECOND_LEVEL.has(parts.at(-2) ?? "") ? 3 : 2;
  const main = parts.at(-tld) ?? "";
  return main.length < 3 || COMMON_DOMAINS.has(main) || STOP.has(main) ? null : main;
}

/** A name in a dictionary, matched as a run of words in another item's text. */
type Alias = { words: string[]; capital: boolean };
type Known = { entity: Entity; aliases: Alias[]; phone?: string; address?: string };

function personOf(item: Item): Known | null {
  const name = (item.name ?? item.title).replace(/\(group\)/i, "");
  const words = tokens(name).filter((token) => !/^\d+$/.test(token.norm));
  const phone = phoneKey(item.id.match(/(\d{7,})@/)?.[1] ?? name);
  if (words.length === 0 && phone === null) return null;
  const first = words[0];
  const label = first === undefined ? (phone ?? "") : capitalise(first.raw);
  const key = words.length > 0 ? `p:${words.map((w) => w.norm).join(" ")}` : `p:tel:${phone}`;
  const aliases: Alias[] = [];
  const full = words.map((w) => w.norm);
  if (full.length > 1 || (full[0] !== undefined && !STOP.has(full[0]) && full[0].length >= 3)) {
    aliases.push({ words: full, capital: false });
  }
  if (first !== undefined && words.length > 1 && first.norm.length >= 3 && !STOP.has(first.norm)) {
    aliases.push({ words: [first.norm], capital: true });
  }
  const known: Known = { entity: { key, kind: "person", label }, aliases };
  if (phone !== null) known.phone = phone;
  if (item.address !== undefined) known.address = item.address;
  return known;
}

function repoOf(item: Item): Known | null {
  const repo = fold(item.repo.trim());
  if (repo === "" || STOP.has(repo)) return null;
  const parts = tokens(item.repo.replace(/[-_.]/g, " ")).map((t) => t.norm);
  const aliases: Alias[] = [{ words: [repo], capital: false }];
  if (parts.length > 1) aliases.push({ words: parts, capital: false });
  return { entity: { key: `r:${repo}`, kind: "repo", label: item.repo }, aliases };
}

function cardOf(item: Item): Known | null {
  const words = tokens(item.title).filter((t) => !STOP.has(t.norm));
  if (words.length < 2) return null;
  const all = tokens(item.title).map((t) => t.norm);
  const label = words
    .slice(0, 2)
    .map((w) => w.raw)
    .join(" ");
  return {
    entity: { key: `k:${all.join(" ")}`, kind: "card", label },
    aliases: [{ words: all, capital: false }],
  };
}

function domainEntity(address: string): Known | null {
  const main = domainOf(address);
  if (main === null) return null;
  return {
    entity: { key: `d:${main}`, kind: "domain", label: capitalise(main) },
    aliases: [{ words: [main], capital: false }],
  };
}

/** What an item is itself: a conversation's person and domain, a session's repository, a card's name. */
function ownOf(item: Item): Known[] {
  if (item.kind === "session") return [repoOf(item)].filter((k): k is Known => k !== null);
  if (item.kind === "card") return [cardOf(item)].filter((k): k is Known => k !== null);
  const own = [personOf(item)];
  if (item.address !== undefined) own.push(domainEntity(item.address));
  return own.filter((k): k is Known => k !== null);
}

function hasRun(words: readonly Token[], alias: Alias): boolean {
  const first = alias.words[0];
  if (first === undefined) return false;
  for (let i = 0; i + alias.words.length <= words.length; i++) {
    const at = words[i];
    if (at?.norm !== first || (alias.capital && !at.capital)) continue;
    if (alias.words.every((word, j) => words[i + j]?.norm === word)) return true;
  }
  return false;
}

type Seen = { words: Token[]; text: string; phones: Set<string>; address?: string };

function seenOf(item: Item): Seen {
  const text = wordsOf(item);
  const phones = new Set(
    [...text.matchAll(PHONE_RE)].flatMap((m) => {
      const key = phoneKey(m[0]);
      return key === null ? [] : [key];
    }),
  );
  const seen: Seen = { words: tokens(text), text: text.toLowerCase(), phones };
  if (item.address !== undefined) seen.address = item.address;
  return seen;
}

function mentions(seen: Seen, known: Known): boolean {
  if (known.phone !== undefined && seen.phones.has(known.phone)) return true;
  if (known.address !== undefined && seen.text.includes(known.address)) return true;
  return known.aliases.some((alias) => hasRun(seen.words, alias));
}

/** Ticket-like ids ("SHOP-12", "prifly-541") and rarer words, the raw material of terms. */
function loose(item: Item, seen: Seen): Entity[] {
  const text = wordsOf(item);
  const tickets = [...text.matchAll(TICKET_RE)].map((m) => ({
    key: `t:${m[0].toLowerCase()}`,
    kind: "ticket" as const,
    label: m[0],
  }));
  const terms = seen.words
    .filter((w) => w.norm.length >= 4 && !STOP.has(w.norm) && !/^\d/.test(w.norm))
    .map((w) => ({ key: `w:${w.norm}`, kind: "term" as const, label: w.raw }));
  return [...tickets, ...terms];
}

/**
 * Each item's entities: its own, the known ones (people, domains, repositories,
 * cards) its text names, its ticket ids and its words. An entity carried by one
 * item only, or (bar a repository) by more than an eighth of them (4 to 6
 * items), is dropped: it ties nothing, or everything.
 */
export function entitiesOf(items: readonly Item[]): Map<string, Entity[]> {
  const dictionary = dictionaryOf(items);
  const found = new Map(items.map((item) => [item.id, foundIn(item, dictionary)]));
  return dropRareAndCommon(found, items.length);
}

/** The known entities: what each item is itself, by key. */
function dictionaryOf(items: readonly Item[]): Map<string, Known> {
  const dictionary = new Map<string, Known>();
  for (const known of items.flatMap(ownOf)) {
    const had = dictionary.get(known.entity.key);
    if (had === undefined) dictionary.set(known.entity.key, known);
    else if (had.address === undefined && known.address !== undefined) had.address = known.address;
  }
  return dictionary;
}

/** One item's entities, by key: its own, the known ones it names, its tickets and words. */
function foundIn(item: Item, dictionary: ReadonlyMap<string, Known>): Map<string, Entity> {
  const seen = seenOf(item);
  const mine = new Map<string, Entity>();
  for (const known of ownOf(item)) mine.set(known.entity.key, known.entity);
  for (const known of dictionary.values()) {
    if (!mine.has(known.entity.key) && mentions(seen, known))
      mine.set(known.entity.key, known.entity);
  }
  for (const entity of loose(item, seen)) if (!mine.has(entity.key)) mine.set(entity.key, entity);
  return mine;
}

function dropRareAndCommon(
  found: Map<string, Map<string, Entity>>,
  count: number,
): Map<string, Entity[]> {
  const df = new Map<string, number>();
  for (const mine of found.values())
    for (const key of mine.keys()) df.set(key, (df.get(key) ?? 0) + 1);
  // The reader's own name, their surname, a word every mail has: on too many items to tell anything apart.
  const cap = Math.min(6, Math.max(4, Math.ceil(count / 8)));
  const out = new Map<string, Entity[]>();
  for (const [id, mine] of found) {
    const kept = [...mine.values()].filter((entity) => {
      const n = df.get(entity.key) ?? 0;
      return n >= 2 && (entity.kind === "repo" || n <= cap);
    });
    out.set(id, kept);
  }
  return out;
}

/** A pair's key, the same either way round. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The label of an entity on a link: 1-2 words, at most 14 characters. */
function shortLabel(label: string): string {
  const words = label.split(/\s+/).slice(0, 2).join(" ");
  return words.length <= 14 ? words : words.slice(0, 14);
}

/**
 * The strong edges: one per pair of items sharing an entity. Sharing an
 * entity weighs by its kind, less the more items carry it, so a repository's
 * many sessions do not outweigh the person two items share.
 */
export function entityEdges(entities: ReadonlyMap<string, readonly Entity[]>): EntityEdge[] {
  const holders = new Map<string, { entity: Entity; ids: string[] }>();
  for (const [id, list] of entities) {
    for (const entity of list) {
      const held = holders.get(entity.key) ?? { entity, ids: [] };
      held.ids.push(id);
      holders.set(entity.key, held);
    }
  }
  const edges = new Map<string, Share>();
  for (const { entity, ids } of holders.values()) {
    const weight = WEIGHT[entity.kind] / Math.sqrt(Math.max(1, ids.length - 1));
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        addShare(edges, sorted[i] ?? "", sorted[j] ?? "", entity, weight);
      }
    }
  }
  return [...edges.values()]
    .filter((edge) => edge.named || edge.terms >= 2 || edge.longTerm)
    .map(({ a, b, weight, label }) => ({ a, b, weight, label }))
    .sort((x, y) => (pairKey(x.a, x.b) < pairKey(y.a, y.b) ? -1 : 1));
}

/**
 * A pair's shares so far. Words alone tie a pair only when it shares two of
 * them, or one long one ("teamtailor", not "plan" or "email").
 */
type Share = EntityEdge & { best: number; named: boolean; terms: number; longTerm: boolean };
const LONG_TERM = 7;

function addShare(
  edges: Map<string, Share>,
  a: string,
  b: string,
  entity: Entity,
  weight: number,
): void {
  const key = pairKey(a, b);
  // The label is the most telling entity: by kind first, then by weight.
  const score = (RANK.length - RANK.indexOf(entity.kind)) * 100 + weight;
  const term = entity.kind === "term";
  const edge = edges.get(key) ?? {
    a,
    b,
    weight: 0,
    label: shortLabel(entity.label),
    best: score,
    named: false,
    terms: 0,
    longTerm: false,
  };
  edge.weight += weight;
  edge.named ||= !term;
  if (term) edge.terms += 1;
  edge.longTerm ||= term && entity.label.length >= LONG_TERM;
  if (score > edge.best) {
    edge.best = score;
    edge.label = shortLabel(entity.label);
  }
  edges.set(key, edge);
}

/**
 * A theme's name without the model: the entity most of its members carry
 * (a person, a ticket, a card, a domain, a repository, then a word), else the
 * repository most of its sessions are in; null when there is none.
 */
export function commonEntity(
  members: readonly Item[],
  entities: ReadonlyMap<string, readonly Entity[]>,
): string | null {
  const counts = new Map<string, { entity: Entity; n: number }>();
  for (const member of members) {
    for (const entity of entities.get(member.id) ?? []) {
      const had = counts.get(entity.key) ?? { entity, n: 0 };
      had.n += 1;
      counts.set(entity.key, had);
    }
  }
  const ranked = [...counts.values()]
    .filter(({ n }) => n >= 2)
    .sort(
      (x, y) =>
        y.n * WEIGHT[y.entity.kind] - x.n * WEIGHT[x.entity.kind] ||
        (x.entity.key < y.entity.key ? -1 : 1),
    );
  const best = ranked[0]?.entity.label;
  if (best !== undefined) return shortLabel(best);
  const repo = members.find((member) => member.kind === "session")?.repo;
  return repo === undefined || repo === "" ? null : repo;
}
