// Asks for the map every few seconds while the page is visible, and not at
// all while it is hidden: the extension reads nothing for a closed map. A new
// session reaches the map within the 15 s the extension reads sessions in.

const EVERY_MS = 5000;

/** Calls `ask()` now, then every 5 s while the page is visible; again as soon as it shows. */
export function startEvery(ask) {
  let timer = null;
  const run = async () => {
    clearTimeout(timer);
    timer = null;
    try {
      await ask();
    } finally {
      if (!document.hidden) timer = setTimeout(() => void run(), EVERY_MS);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void run();
  });
  void run();
}
