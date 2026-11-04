// The right-click menu on a circle, and what a click on a circle does. The
// extension says where a circle can be opened (`node.menu`); a session opens
// inside prifly, anything else goes to `api/open`, which opens the item's own
// link in the reader's browser. The page never holds or sends a URL.

const MARGIN = 8;
const NOTE_MS = 4000;
const BROWSER_FAILED = "prifly could not open the browser";

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

/** Shows the menu for `node` at the pointer (x, y in window pixels). */
export function openMenu(node, x, y) {
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
