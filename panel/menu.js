// The right-click menu on a circle, and what a click on a circle does. The
// extension says where a circle can be opened (`node.menu`); a session opens
// inside prifly, anything else goes to `api/open`, which opens the item's own
// link in the reader's browser. The page never holds or sends a URL. With the
// reader's areas, "Move to theme…" lists them and their sub-topics; a choice
// goes to `api/move`, and "Reset placement" gives the circle back to the model.

const MARGIN = 8;
const NOTE_MS = 4000;
const BROWSER_FAILED = "prifly could not open the browser";
const MOVE_FAILED = "The map could not move it";

let menu = null;
let noteTimer = null;

/** What a circle offers; an older saved map has no menu, so a session still opens in prifly. */
export function menuOf(node) {
  if (Array.isArray(node.menu)) return node.menu;
  return node.kind === "session"
    ? [{ label: "Open in prifly", target: node.id, where: "prifly" }]
    : [];
}

/** A short note over the map; it goes by itself. */
export function note(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    el.hidden = true;
  }, NOTE_MS);
}

/** Opens one entry of `node`'s menu. */
export async function choose(node, entry) {
  if (entry.where === "prifly") {
    parent.postMessage({ type: "prifly-open-session", session: entry.target }, "*");
    return;
  }
  try {
    const response = await fetch("api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: node.id, target: entry.target }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
    if (body.opened !== true) note(BROWSER_FAILED);
  } catch (error) {
    note(error instanceof Error && error.message ? error.message : BROWSER_FAILED);
  }
}

export function closeMenu() {
  menu?.remove();
  menu = null;
}

function line(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "item";
  button.setAttribute("role", "menuitem");
  button.textContent = text;
  button.title = text;
  return button;
}

/** Puts the menu at the pointer, moved back inside the window when it would spill out. */
function place(el, x, y) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const box = el.getBoundingClientRect();
  const left = Math.max(MARGIN, Math.min(x, innerWidth - box.width - MARGIN));
  const top = Math.max(MARGIN, Math.min(y, innerHeight - box.height - MARGIN));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/**
 * Posts a move to `api/move` (an area and sub-topic, or `reset`) and draws the
 * map it answers with `show`; a refusal is said in a note.
 */
async function move(node, body, show) {
  try {
    const response = await fetch("api/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: node.id, ...body }),
    });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer?.error ?? `HTTP ${response.status}`);
    show?.(answer);
  } catch (error) {
    note(error instanceof Error && error.message ? error.message : MOVE_FAILED);
  }
}

function divider() {
  const hr = document.createElement("div");
  hr.className = "divider";
  hr.setAttribute("role", "separator");
  return hr;
}

/** One line of the "Move to theme…" list, ticked where the circle is now. */
function spot(text, current, cls) {
  const button = line(text);
  button.classList.add(cls);
  button.setAttribute("role", "menuitemradio");
  button.setAttribute("aria-checked", current ? "true" : "false");
  return button;
}

/** The menu's lines turned into the list of areas and their sub-topics. */
function showMoveList(el, node, context, x, y) {
  el.replaceChildren();
  el.classList.add("move");
  const head = document.createElement("p");
  head.className = "head";
  head.textContent = "Move to theme";
  el.append(head);
  for (const area of context.areas) {
    const here = node.theme === area.id;
    const top = spot(area.name, here && !node.sub, "area");
    top.addEventListener("click", () => {
      closeMenu();
      void move(node, { area: area.id, sub: "" }, context.show);
    });
    el.append(top);
    for (const sub of area.subs) {
      const button = spot(sub, here && node.sub === sub, "sub");
      button.addEventListener("click", () => {
        closeMenu();
        void move(node, { area: area.id, sub }, context.show);
      });
      el.append(button);
    }
  }
  place(el, x, y);
  (el.querySelector('[aria-checked="true"]') ?? el.querySelector(".item"))?.focus({
    preventScroll: true,
  });
}

/** "Move to theme…" and, for a circle the reader placed, "Reset placement". */
function moveLines(el, node, context, x, y) {
  if (!Array.isArray(context.areas) || context.areas.length === 0) return;
  el.append(divider());
  const open = line("Move to theme…");
  open.setAttribute("aria-haspopup", "menu");
  open.addEventListener("click", () => showMoveList(el, node, context, x, y));
  el.append(open);
  if (node.manual !== true) return;
  const reset = line("Reset placement");
  reset.addEventListener("click", () => {
    closeMenu();
    void move(node, { reset: true }, context.show);
  });
  el.append(reset);
}

/**
 * Shows the menu for `node` at the pointer (x, y in window pixels). `context`
 * has the map's `areas` (for "Move to theme…") and `show`, which draws the
 * map a move answers.
 */
export function openMenu(node, x, y, context = {}) {
  closeMenu();
  const entries = menuOf(node);
  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", node.title);
  if (entries.length === 0) {
    const none = line("Nothing to open");
    none.disabled = true;
    el.append(none);
  }
  for (const entry of entries) {
    const button = line(entry.label);
    button.addEventListener("click", () => {
      closeMenu();
      void choose(node, entry);
    });
    el.append(button);
  }
  moveLines(el, node, context, x, y);
  document.body.append(el);
  menu = el;
  place(el, x, y);
  el.querySelector(".item:not(:disabled)")?.focus({ preventScroll: true });
}

function step(direction) {
  const items = [...menu.querySelectorAll(".item:not(:disabled)")];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement);
  items[(at + direction + items.length) % items.length].focus();
}

// Closes on Escape, a press outside or a resize; the arrows move between lines.
document.addEventListener("keydown", (event) => {
  if (menu === null) return;
  if (event.key === "Escape") closeMenu();
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    step(event.key === "ArrowDown" ? 1 : -1);
  }
});
document.addEventListener(
  "pointerdown",
  (event) => {
    if (menu !== null && !menu.contains(event.target)) closeMenu();
  },
  true,
);
addEventListener("resize", closeMenu);
addEventListener("blur", closeMenu);
