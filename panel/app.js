// The Mind map window: asks `api/map` while visible, draws it, and eases every
// circle and label from where it was to where the extension now puts it. A
// click on a session opens it in prifly; on a card or a conversation with a
// link, opens that link. The map itself never sends or changes anything.

import { drawMap, esc } from "./draw.js";
import { startEvery } from "./every.js";

const $ = (id) => document.getElementById(id);
const EASE_MS = 700;

let shown = null; // the view as last drawn, positions eased
let target = null; // the view the extension last answered
let frame = 0;

function dark() {
  return document.documentElement.classList.contains("dark");
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function linkKey(link) {
  return `${link.a}>${link.b}>${link.kind}`;
}

/** `to` with every position moved `t` of the way from where `from` had it. */
function between(from, to, t) {
  if (from === null) return to;
  const before = new Map([...from.themes, ...from.nodes].map((c) => [c.id, c]));
  const themeAt = new Map(to.themes.map((th) => [th.id, th]));
  const ease = (c, start) =>
    start ? { ...c, x: lerp(start.x, c.x, t), y: lerp(start.y, c.y, t) } : c;
  const themes = to.themes.map((th) => ease(th, before.get(th.id)));
  // A new circle grows out of its theme.
  const nodes = to.nodes.map((m) => ease(m, before.get(m.id) ?? themeAt.get(m.theme)));
  const labels = new Map(from.links.map((l) => [linkKey(l), l.label]));
  const links = to.links.map((l) => {
    const start = labels.get(linkKey(l));
    return start
      ? {
          ...l,
          label: { ...l.label, x: lerp(start.x, l.label.x, t), y: lerp(start.y, l.label.y, t) },
        }
      : l;
  });
  return { ...to, themes, nodes, links };
}

function paint(view) {
  $("map").innerHTML = drawMap(view, dark());
}

function animate(next) {
  cancelAnimationFrame(frame);
  const from = shown;
  target = next;
  const start = performance.now();
  const step = (now) => {
    const raw = Math.min(1, (now - start) / EASE_MS);
    const t = raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2;
    shown = between(from, next, t);
    paint(shown);
    if (raw < 1) frame = requestAnimationFrame(step);
  };
  if (from === null || document.hidden) {
    shown = next;
    paint(next);
  } else frame = requestAnimationFrame(step);
}

function swatch(svg) {
  return `<svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">${svg}</svg>`;
}

const LEGEND = [
  [
    swatch('<circle cx="11" cy="8" r="6.5" fill="#e8f0fb" stroke="#2a78d6" stroke-width="1.5"/>'),
    "Session",
  ],
  [
    swatch(
      '<circle cx="11" cy="8" r="4.5" fill="#e8f0fb" stroke="#2a78d6" stroke-width="1.2"/><circle cx="11" cy="8" r="6.8" fill="none" stroke="#25d366" stroke-width="1.5"/>',
    ),
    "Conversation or card, ringed in its service's colour",
  ],
  [swatch('<circle cx="11" cy="8" r="4.5" fill="var(--good)"/>'), "Running"],
  [swatch('<circle cx="11" cy="8" r="4.5" fill="var(--warning)"/>'), "Waiting on you"],
  [swatch('<circle cx="11" cy="8" r="4.5" fill="var(--critical)"/>'), "Error"],
  [swatch('<circle cx="11" cy="8" r="4.5" fill="var(--neutral)"/>'), "Idle or snoozed"],
  [
    swatch(
      '<path d="M1,8 L17,8" stroke="var(--link)" stroke-width="2"/><path d="M15,4 L21,8 L15,12 z" fill="var(--link)"/>',
    ),
    "Started, waits on, ticket",
  ],
  [
    swatch('<path d="M1,8 L21,8" stroke="var(--link)" stroke-width="1.5" stroke-dasharray="4 3"/>'),
    "Related",
  ],
];

function drawLegend(view) {
  const services = view.legend.services.map(
    (s) =>
      `<span>${swatch(`<circle cx="11" cy="8" r="6" fill="none" stroke="${s.color}" stroke-width="2.5"/>`)}${esc(s.name)}</span>`,
  );
  $("legend").innerHTML = [
    ...LEGEND.map(([icon, text]) => `<span>${icon}${esc(text)}</span>`),
    ...services,
  ].join("");
}

function drawFooter(view) {
  const f = view.footer;
  const parts = [
    `${f.sessions} sessions, ${f.conversations} conversations, ${f.cards} cards`,
    f.model,
  ];
  if (f.skipped.length > 0) parts.push(`Not read: ${f.skipped.join(", ")}`);
  $("footer").textContent = parts.join(" · ");
}

function say(text, error = false) {
  const message = $("message");
  message.hidden = text === "";
  message.textContent = text;
  message.classList.toggle("error", error);
}

async function refresh() {
  try {
    const response = await fetch("api/map", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
    say(body.nodes.length === 0 ? "No sessions to map yet." : "");
    drawLegend(body);
    drawFooter(body);
    animate(body);
  } catch (error) {
    // Keep the last map on screen; say what went wrong over it only when there is none.
    if (target === null) say(`Could not read the map: ${error.message}`, true);
    else $("footer").textContent = `Could not update the map: ${error.message}`;
  }
}

$("map").addEventListener("click", (event) => {
  const g = event.target.closest?.(".node");
  if (!g || target === null) return;
  const node = target.nodes.find((m) => m.id === g.dataset.id);
  if (!node) return;
  if (node.kind === "session") {
    parent.postMessage({ type: "prifly-open-session", session: node.id }, "*");
  } else if (node.url) {
    window.open(node.url, "_blank", "noreferrer");
  }
});

const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
};
addEventListener("message", (event) => {
  if (event.data?.type !== "prifly-look") return;
  document.documentElement.classList.toggle("dark", event.data.dark === true);
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = event.data.tokens?.[theirs];
    if (typeof value === "string" && value !== "")
      document.documentElement.style.setProperty(ours, value);
  }
  if (shown !== null) paint(shown);
});

startEvery(refresh);
