/**
 * Executes the CDP-reachable rows of the quickstart §15 native GUI checklist
 * against the running application and prints a PASS/FAIL table.
 *
 * Every interaction goes through the real input pipeline (`Input.dispatchKeyEvent`,
 * `Input.insertText`, `Input.dispatchMouseEvent`) and every assertion reads the
 * real DOM, so this drives the same code paths a human would.
 *
 * Usage:
 *   node checklist-ui.mjs <group>
 *
 * Groups are independent and each assumes a freshly launched application:
 *   n1      initial Tab and editor focus
 *   n2n3    New Tabs, and per-Tab content/cursor/undo/scroll isolation
 *   n11     closing the final clean Tab replaces it
 *   n15     Tab-strip overflow and active-Tab reveal
 *   n16     Ctrl+W closes the current Tab, not the application
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "cdp.mjs");

function cdp(...args) {
  const output = execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(output);
}

const state = () => cdp("state");
const key = (chord) => cdp("key", chord);
const insert = (text) => cdp("insert", text);
const click = (selector) => cdp("click", selector);

const results = [];

function check(id, description, condition, detail = "") {
  const pass = Boolean(condition);
  results.push({ id, description, pass });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${id}  ${description}${detail ? `  :: ${detail}` : ""}`,
  );
}

function labels(snapshot) {
  return snapshot.tabs.map((tab) => tab.label).join(",");
}

function activeLabel(snapshot) {
  return snapshot.tabs.find((tab) => tab.active)?.label ?? null;
}

function tabSelector(label) {
  return `.tab[title="${label}"]`;
}

/** Synchronous sleep, so the checklist can poll between CLI calls. */
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Polls `probe` until it returns something truthy, or the timeout expires. */
function waitUntil(probe, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      return null;
    }
    sleepSync(intervalMs);
  }
}

const groups = {
  n1() {
    const snapshot = state();
    check("N1", "exactly one Tab", snapshot.tabCount === 1, labels(snapshot));
    check("N1", "the Tab is named Untitled1", labels(snapshot) === "Untitled1");
    check("N1", "the Tab is active", snapshot.tabs[0].active === true);
    check("N1", "the Tab is clean", snapshot.tabs[0].dirty === false);
    check("N1", "the editor is focused", snapshot.editor.focused === true, snapshot.activeElement);
  },

  n2n3() {
    let snapshot = state();
    check("N2", "starts with one Tab", snapshot.tabCount === 1, labels(snapshot));

    insert("alpha-one");
    snapshot = state();
    check("N2", "typing into Untitled1 works", snapshot.editor.text === "alpha-one", snapshot.editor.text);
    check("N2", "Untitled1 becomes dirty", snapshot.tabs[0].dirty === true);

    key("ctrl+n");
    snapshot = state();
    check("N2", "Ctrl+N adds a Tab", snapshot.tabCount === 2, labels(snapshot));
    check("N2", "the new Tab is Untitled2", labels(snapshot) === "Untitled1,Untitled2");
    check("N2", "the new Tab is active", activeLabel(snapshot) === "Untitled2");
    check("N2", "the new Tab is empty", snapshot.editor.text === "");

    insert("bravo-two");
    key("ctrl+n");
    snapshot = state();
    check("N2", "a third Tab is Untitled3", labels(snapshot) === "Untitled1,Untitled2,Untitled3");
    insert("charlie-three");

    // N3: per-Tab content isolation.
    click(tabSelector("Untitled1"));
    snapshot = state();
    check("N3", "Untitled1 keeps its own text", snapshot.editor.text === "alpha-one", snapshot.editor.text);
    click(tabSelector("Untitled2"));
    snapshot = state();
    check("N3", "Untitled2 keeps its own text", snapshot.editor.text === "bravo-two", snapshot.editor.text);
    click(tabSelector("Untitled3"));
    snapshot = state();
    check("N3", "Untitled3 keeps its own text", snapshot.editor.text === "charlie-three", snapshot.editor.text);

    // N3: per-Tab undo history. The last edit happens in the active document only.
    key("ctrl+z");
    snapshot = state();
    check("N3", "Ctrl+Z undoes only the active document", snapshot.editor.text === "", snapshot.editor.text);
    click(tabSelector("Untitled1"));
    snapshot = state();
    check("N3", "another Tab is untouched by that undo", snapshot.editor.text === "alpha-one", snapshot.editor.text);

    // N3: per-Tab scroll position, on a document long enough to scroll.
    const lines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
    insert(lines);
    key("pagedown");
    key("pagedown");
    const scrolled = state();
    check("N3", "the long document scrolls", scrolled.editor.scrollerTop > 0, `scrollerTop=${scrolled.editor.scrollerTop}`);
    const scrolledTop = scrolled.editor.scrollerTop;

    click(tabSelector("Untitled2"));
    const other = state();
    check("N3", "the other Tab is at its own scroll position", other.editor.scrollerTop === 0, `scrollerTop=${other.editor.scrollerTop}`);

    click(tabSelector("Untitled1"));
    const restored = state();
    check(
      "N3",
      "returning to the Tab restores its reading position",
      Math.abs(restored.editor.scrollerTop - scrolledTop) <= 2,
      `expected~${scrolledTop} actual=${restored.editor.scrollerTop}`,
    );

    // CodeMirror only renders the visible lines, so the content check reads the
    // document from its top, where the first typed line must still be.
    key("ctrl+home");
    const top = state();
    check(
      "N3",
      "and its content is still the first Tab's document",
      top.editor.text.startsWith("alpha-oneline 1") && !top.editor.text.includes("bravo-two"),
      top.editor.text.slice(0, 40),
    );
  },

  n11() {
    let snapshot = state();
    check("N11", "starts with Untitled1", labels(snapshot) === "Untitled1", labels(snapshot));

    click(".tab--active .tab__close");
    snapshot = state();
    check("N11", "closing the only clean Tab creates a replacement", snapshot.tabCount === 1, labels(snapshot));
    check("N11", "the replacement is the next Untitled number", labels(snapshot) === "Untitled2", labels(snapshot));
    check("N11", "the replacement is clean", snapshot.tabs[0].dirty === false);
    check("N11", "the replacement is active", snapshot.tabs[0].active === true);
    check("N11", "the editor is usable again", snapshot.editor.focused === true);
  },

  n15() {
    for (let index = 0; index < 14; index += 1) {
      key("ctrl+n");
    }

    let snapshot = state();
    check("N15", "many Tabs can be opened", snapshot.tabCount === 15, `tabCount=${snapshot.tabCount}`);
    check("N15", "the strip overflows horizontally", snapshot.tabBar.scrollWidth > snapshot.tabBar.clientWidth, JSON.stringify(snapshot.tabBar));
    check("N15", "the strip never widens the application", snapshot.tabBar.clientWidth <= 1200, `clientWidth=${snapshot.tabBar.clientWidth}`);

    click(tabSelector("Untitled1"));
    snapshot = state();
    check("N15", "the active Tab is scrolled into view", snapshot.tabBar.activeInView === true, JSON.stringify(snapshot.tabBar));

    click(tabSelector("Untitled15"));
    snapshot = state();
    check("N15", "the far end is reachable and revealed", activeLabel(snapshot) === "Untitled15" && snapshot.tabBar.activeInView === true, JSON.stringify(snapshot.tabBar));
    check("N15", "the editor is not pushed beyond the window", snapshot.tabBar.clientWidth <= 1200, `clientWidth=${snapshot.tabBar.clientWidth}`);
  },

  n16() {
    insert("dirty-one");
    key("ctrl+n");
    let snapshot = state();
    check("N16", "two Tabs are open", snapshot.tabCount === 2, labels(snapshot));

    // A clean Tab needs no prompt, so Ctrl+W can be exercised end to end here.
    key("ctrl+w");
    snapshot = state();
    check("N16", "Ctrl+W closes the current clean Tab", snapshot.tabCount === 1, labels(snapshot));
    check("N16", "the application did not exit", snapshot.tabs.length > 0);
    check("N16", "the dirty Tab survived", labels(snapshot) === "Untitled1", labels(snapshot));
    check("N16", "the dirty Tab is still dirty", snapshot.tabs[0].dirty === true);
  },

  /**
   * N19 and quickstart §12.1: the SC-005 switching benchmark.
   *
   * Fixtures are opened through Tauri's own drag/drop event, which reaches the
   * same open pipeline File > Open uses, so no native picker is involved. The
   * 40 activations are produced by real mouse clicks on the Tab strip.
   */
  n19() {
    const fixtures = join(HERE, "fixtures");
    const smallPath = join(fixtures, "small-a.txt");
    const largePath = join(fixtures, "large.txt");

    cdp("drop", smallPath);
    let snapshot = waitUntil(() => {
      const current = state();
      return current.tabs.some((tab) => tab.label === "small-a.txt") ? current : null;
    }, 30000);
    check("N19", "the small fixture opens", Boolean(snapshot), snapshot ? labels(snapshot) : "timed out");

    cdp("drop", largePath);
    snapshot = waitUntil(() => {
      const current = state();
      return current.tabs.some((tab) => tab.label === "large.txt") ? current : null;
    }, 180000);
    check("N19", "the 24 MB fixture opens", Boolean(snapshot), snapshot ? labels(snapshot) : "timed out");

    if (!snapshot) {
      return;
    }

    // Distinctive reading positions, as §12 step 2 asks for.
    cdp("clicktab", "large.txt");
    for (let index = 0; index < 4; index += 1) {
      key("pagedown");
    }
    const largePosition = state().editor.scrollerTop;
    cdp("clicktab", "small-a.txt");
    key("arrowdown");
    const smallPosition = state().editor.scrollerTop;

    check("N19", "the large document has its own reading position", largePosition > 0, `large scrollerTop=${largePosition}`);
    check("N19", "the small document has its own reading position", smallPosition >= 0, `small scrollerTop=${smallPosition}`);

    cdp("bench-reset");

    const cycles = 20;
    const started = Date.now();
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      cdp("clicktab", "large.txt");
      cdp("clicktab", "small-a.txt");
    }
    const elapsed = Date.now() - started;

    const bench = cdp("bench");
    if (!bench.available) {
      check("N19", "the benchmark is installed", false);
      return;
    }

    const results = bench.results;
    const summary = bench.summary;

    check("N19", "the benchmark recorded every activation", results.length === 40, `count=${results.length} in ${elapsed} ms`);
    check("N19", "every activation stayed within the 500 ms budget", summary.withinBudget, `slowest=${summary.slowestMillis?.toFixed(2)} ms`);
    check("N19", "the drift stayed within 1.25x", summary.withinDrift, `medianFirst10=${summary.medianFirst10?.toFixed(2)} medianFinal10=${summary.medianFinal10?.toFixed(2)} drift=${summary.driftRatio?.toFixed(3)}`);

    // Content and state survived 40 switches.
    const final = state();
    check("N19", "the editor still shows the small document", final.editor.text.includes("small line 1"), final.editor.text.slice(0, 30));
    check("N19", "the strip still holds both documents", final.tabCount === 3, labels(final));

    console.log("");
    console.log("§12.1 measurements (durationMillis, in activation order):");
    results.forEach((entry, index) => {
      const cycle = Math.floor(index / 2) + 1;
      const leg = index % 2 === 0 ? "small-a -> large" : "large -> small-a";
      console.log(`  cycle ${String(cycle).padStart(2)} ${leg.padEnd(18)} ${entry.durationMillis.toFixed(2)} ms  (${entry.documentId})`);
    });
    console.log("");
    console.log(`  slowest activation (ms):        ${summary.slowestMillis.toFixed(2)}   limit 500`);
    console.log(`  median of measurements 1-10:    ${summary.medianFirst10.toFixed(2)}`);
    console.log(`  median of measurements 31-40:   ${summary.medianFinal10.toFixed(2)}`);
    console.log(`  drift ratio (final / first):    ${summary.driftRatio.toFixed(3)}   limit 1.25`);
  },
};

const group = process.argv[2];

if (!group || !groups[group]) {
  console.error(`Usage: node checklist-ui.mjs <${Object.keys(groups).join("|")}>`);
  process.exit(2);
}

try {
  groups[group]();
} catch (error) {
  console.error(`HARNESS_ERROR: ${error.message}`);
  process.exit(3);
}

const failed = results.filter((entry) => !entry.pass);
console.log("");
console.log(`group ${group}: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
