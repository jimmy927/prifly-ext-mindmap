// Draws one frame of the map as SVG. Every place, bend and label spot comes
// from the extension (`api/map`); this only turns them into shapes. A curve
// from a to b bent by `bend` has its control point at the midpoint moved
// across the line by bend times its length — the extension's `curves.ts`.

const ROOT_FILL = "#2d3340";
const STATUS = {
  running: "var(--good)",
  waiting: "var(--warning)",
  error: "var(--critical)",
  idle: "var(--neutral)",
};

export function esc(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function control(a, b, bend) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend };
}

function pointAt(a, c, b, t) {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

function n(value) {
  return Math.round(value * 10) / 10;
}

function curve(a, b, bend) {
  const c = control(a, b, bend);
  return `M${n(a.x)},${n(a.y)} Q${n(c.x)},${n(c.y)} ${n(b.x)},${n(b.y)}`;
}

/** The t where the curve leaves a circle of radius r round its end (from 1 down), by halving. */
function rimT(a, c, b, r, fromEnd) {
  let inside = fromEnd ? 1 : 0;
  let outside = 0.5;
  const centre = fromEnd ? b : a;
  for (let i = 0; i < 20; i++) {
    const mid = (inside + outside) / 2;
    const p = pointAt(a, c, b, mid);
    if (Math.hypot(p.x - centre.x, p.y - centre.y) < r) inside = mid;
    else outside = mid;
  }
  return outside;
}

/** The curve from rim to rim, as a path of the sub-curve between the two t's. */
function rimCurve(a, b, bend, ra, rb) {
  const c = control(a, b, bend);
  const t0 = rimT(a, c, b, ra, false);
  const t1 = rimT(a, c, b, rb, true);
  // The piece of a quadratic between t0 and t1 is a quadratic too: its control
  // point is the blossom B(t0, t1).
  const p0 = pointAt(a, c, b, t0);
  const p1 = pointAt(a, c, b, t1);
  const mix = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const k = mix(mix(a, c, t0), mix(c, b, t0), t1);
  return `M${n(p0.x)},${n(p0.y)} Q${n(k.x)},${n(k.y)} ${n(p1.x)},${n(p1.y)}`;
}

/** `colour` at `share` over `base`, both #rrggbb. */
export function tint(colour, share, base) {
  const parse = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [r, g, b] = parse(colour);
  const [R, G, B] = parse(base);
  const mix = (x, y) => Math.round(x * share + y * (1 - share));
  return `rgb(${mix(r, R)},${mix(g, G)},${mix(b, B)})`;
}

/** Words into at most `count` lines of `chars`, the last cut with an ellipsis. */
export function wrap(text, chars, count) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length <= chars) line = next;
    else {
      if (line !== "") lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  const cut = (l) => `${l.slice(0, chars - 1).trimEnd()}…`;
  const kept = lines.slice(0, count).map((l) => (l.length > chars ? cut(l) : l));
  const last = kept.length - 1;
  if (lines.length > count && !kept[last].endsWith("…")) kept[last] = cut(`${kept[last]}  `);
  return kept;
}

function textBlock(x, y, rows) {
  // rows: [{ text, cls, size }]; centred as a block on y.
  const height = rows.reduce((sum, row) => sum + row.size * 1.2, 0);
  let at = y - height / 2;
  return rows
    .map((row) => {
      at += row.size * 1.2;
      const fill = row.fill ? ` fill="${row.fill}"` : "";
      const weight = row.bold ? ` font-weight="600"` : "";
      return `<text x="${n(x)}" y="${n(at - row.size * 0.28)}" text-anchor="middle" class="${row.cls}" font-size="${row.size}"${fill}${weight}>${esc(row.text)}</text>`;
    })
    .join("");
}

function themeShape(theme) {
  const rows = [
    ...wrap(theme.name, 12, 2).map((text) => ({
      text,
      cls: "",
      size: 13,
      bold: true,
      fill: "#ffffff",
    })),
    ...wrap(theme.sub, 16, 1).map((text) => ({
      text,
      cls: "",
      size: 9.5,
      fill: "rgba(255,255,255,0.85)",
    })),
  ];
  return `<g class="theme"><circle cx="${n(theme.x)}" cy="${n(theme.y)}" r="${theme.r}" fill="${theme.color}"/>${textBlock(theme.x, theme.y, rows)}</g>`;
}

function nodeShape(node, base) {
  const small = node.kind !== "session";
  const chars = small ? 12 : 16;
  const rows = [
    ...wrap(node.title, chars, 2).map((text) => ({ text, cls: "title", size: small ? 10 : 11 })),
    ...node.lines.slice(0, small ? 1 : 2).map((text) => ({
      text: text.length > (small ? 14 : 22) ? `${text.slice(0, small ? 13 : 21)}…` : text,
      cls: "line",
      size: small ? 8.5 : 9,
    })),
  ];
  const click = node.kind === "session" || node.url ? " click" : "";
  const ring = small
    ? `<circle cx="${n(node.x)}" cy="${n(node.y)}" r="${node.r + 3.5}" fill="none" stroke="${node.ring}" stroke-width="2.5"/>`
    : "";
  const dot = node.status ? statusDot(node) : "";
  const title = node.service ? `${node.service}: ${node.title}` : node.title;
  return `<g class="node${click}" data-id="${esc(node.id)}">${ring}<circle class="body" cx="${n(node.x)}" cy="${n(node.y)}" r="${node.r}" fill="${tint(node.color, 0.12, base)}" stroke="${node.color}" stroke-width="2"/>${textBlock(node.x, node.y, rows)}${dot}<title>${esc(title)}</title></g>`;
}

function statusDot(node) {
  const angle = -Math.PI / 4;
  const x = node.x + node.r * Math.cos(angle);
  const y = node.y + node.r * Math.sin(angle);
  return `<circle cx="${n(x)}" cy="${n(y)}" r="6.5" fill="${STATUS[node.status] ?? STATUS.idle}" stroke="var(--bg)" stroke-width="2"/>`;
}

function linkShape(link, circles) {
  const a = circles.get(link.a);
  const b = circles.get(link.b);
  if (!a || !b) return "";
  const path = rimCurve(a, b, link.bend, a.r + 2, b.r + (link.kind === "related" ? 2 : 4));
  if (link.kind === "related") {
    return `<path d="${path}" fill="none" stroke="var(--link)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.85"/>`;
  }
  return `<path d="${path}" fill="none" stroke="var(--link)" stroke-width="2" marker-end="url(#arrow)"/>`;
}

/** The whole map at the positions in `view` (already eased by the caller). */
export function drawMap(view, dark) {
  const base = dark ? "#16191e" : "#ffffff";
  const circles = new Map([
    ["root", view.root],
    ...view.themes.map((t) => [t.id, t]),
    ...view.nodes.map((m) => [m.id, m]),
  ]);
  const themeById = new Map(view.themes.map((t) => [t.id, t]));
  const trunks = view.themes
    .map(
      (t) =>
        `<path d="${curve(view.root, t, t.bend)}" fill="none" stroke="${t.color}" stroke-width="10" stroke-linecap="round" opacity="0.55"/>`,
    )
    .join("");
  const branches = view.nodes
    .map((m) => {
      const t = themeById.get(m.theme);
      return t
        ? `<path d="${curve(t, m, m.bend)}" fill="none" stroke="${t.color}" stroke-width="3.5" stroke-linecap="round" opacity="0.55"/>`
        : "";
    })
    .join("");
  const links = view.links.map((link) => linkShape(link, circles)).join("");
  const root = `<g><circle cx="${n(view.root.x)}" cy="${n(view.root.y)}" r="${view.root.r}" fill="${ROOT_FILL}"/>${textBlock(view.root.x, view.root.y, [{ text: view.root.label, cls: "", size: 14, bold: true, fill: "#ffffff" }])}</g>`;
  const labels = view.links
    .map(
      (link) =>
        `<text class="label" x="${n(link.label.x)}" y="${n(link.label.y + 3.5)}" text-anchor="middle">${esc(link.label.text)}</text>`,
    )
    .join("");
  const defs = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--link)"/></marker></defs>`;
  return `${defs}${trunks}${branches}${links}${root}${view.themes.map(themeShape).join("")}${view.nodes.map((m) => nodeShape(m, base)).join("")}${labels}`;
}
