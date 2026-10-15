/**
 * Executes the native-dialog rows of the quickstart §15 checklist.
 *
 * The web layer is driven through CDP (`cdp.mjs`); the native pickers and
 * message boxes are driven through Win32 control ids and real mouse events
 * (`uia.ps1`). Every group starts from a freshly launched application.
 *
 * Usage:
 *   node checklist-native.mjs <group>
 *
 * Groups:
 *   n4   Save As renames a Tab and Untitled numbers keep increasing
 *   n5   File > Open adds a Tab instead of replacing
 *   n6   one session per file across Open and drag/drop
 *   n7   Save As onto an already-open document is rejected
 *   n8   Save As writes the file and renames only afterwards
 *   n9   dirty Tab close: Save / Don't Save / Cancel
 *   n10  closing an inactive dirty Tab does not activate it
 *   n12  window close aborts on Cancel, keeping earlier decisions
 *   n13  window close with everything approved destroys the window
 *   n14  a mixed dropped batch continues past a failure and skips folders
 *   n17  UTF-8 BOM + CRLF survive an untouched save byte for byte
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "cdp.mjs");
const UIA = join(HERE, "uia.ps1");
const PS7 = "D:\\Program Files\\PowerShell\\7\\pwsh.exe";
const FIXTURES = join(HERE, "fixtures");

function cdp(...args) {
  const output = execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // A modal native dialog can make the webview stop answering; fail loudly
    // instead of stalling the whole checklist.
    timeout: 25000,
  });
  return JSON.parse(output);
}

/** Runs a uia.ps1 action; returns stdout, or a diagnostic string on failure. */
function uia(...args) {
  try {
    return execFileSync(PS7, ["-NoProfile", "-File", UIA, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 40000,
    }).trim();
  } catch (error) {
    const stdout = (error.stdout ?? "").toString().trim();
    if (error.code === "ETIMEDOUT" || error.signal) {
      return `UIA_TIMEOUT: ${stdout || error.message}`;
    }
    return `UIA_ERROR: ${stdout || error.message}`;
  }
}

const state = () => cdp("state");
const key = (chord) => cdp("key", chord);
const insert = (text) => cdp("insert", text);
const clickTab = (needle) => cdp("clicktab", needle);
const clickSelector = (selector) => cdp("click", selector);
const drop = (...paths) => cdp("drop", ...paths);

const results = [];

function check(id, description, condition, detail = "") {
  const pass = Boolean(condition);
  results.push({ id, description, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${description}${detail ? `  :: ${detail}` : ""}`);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitUntil(probe, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    sleepSync(intervalMs);
  }
}

const labels = (snapshot) => snapshot.tabs.map((tab) => tab.label).join(",");
const activeLabel = (snapshot) => snapshot.tabs.find((tab) => tab.active)?.label ?? null;

/** Waits for a native dialog of the given title/class to be on screen. */
function waitForDialog(title, klass = "#32770", timeoutMs = 15000) {
  return waitUntil(() => {
    const listing = uia("list");
    return listing
      .split("\n")
      .some((line) => line.includes(`title='${title}`) || (line.includes(title) && line.includes(klass)))
      ? listing
      : null;
  }, timeoutMs, 300);
}

function fixturePath(name) {
  return join(FIXTURES, name);
}

function freshTarget(name) {
  const target = fixturePath(name);
  if (existsSync(target)) rmSync(target, { force: true });
  return target;
}

/** The Save As flow: trigger it, fill the picker, accept. */
function saveAsTo(path, expectedTitle = "Save As") {
  key("ctrl+shift+s");
  waitForDialog(expectedTitle);
  return uia("set-path-and-accept", "-TitleContains", expectedTitle, "-ClassContains", "#32770", "-Value", path, "-TimeoutSeconds", "15");
}

/** The Open flow: trigger it, fill the picker, accept. */
function openPath(path) {
  key("ctrl+o");
  waitForDialog("Open");
  return uia("set-path-and-accept", "-TitleContains", "Open", "-ClassContains", "#32770", "-Value", path, "-TimeoutSeconds", "15");
}

const AI_DIR = fixturePath("a-folder");
const BINARY = fixturePath("unsupported.bin");
const SMALL_A = fixturePath("small-a.txt");
const SMALL_B = fixturePath("small-b.txt");
const BOM_CRLF = fixturePath("utf8bom-crlf.txt");

const groups = {
  n4() {
    const target = freshTarget("n4-saved.txt");
    insert("n4 content");

    saveAsTo(target);
    waitUntil(() => (state().tabs.some((tab) => tab.label === "n4-saved.txt") ? true : null), 20000);
    let snapshot = state();
    check("N4", "Untitled1 was saved under its chosen name", snapshot.tabs.some((tab) => tab.label === "n4-saved.txt"), labels(snapshot));

    // Closing the only (now clean) Tab replaces it with Untitled2.
    key("ctrl+w");
    snapshot = waitUntil(() => {
      const current = state();
      return current.tabs.length === 1 && current.tabs[0].label === "Untitled2" ? current : null;
    }, 20000);
    check("N4", "closing the saved Tab replaces it with Untitled2", Boolean(snapshot), snapshot ? labels(snapshot) : "timed out");

    key("ctrl+n");
    snapshot = state();
    check("N4", "the next New continues the sequence", labels(snapshot) === "Untitled2,Untitled3", labels(snapshot));
    check("N4", "the saved name is never reused", !labels(snapshot).includes("Untitled1"));
  },

  n8() {
    const target = freshTarget("n8-saved.txt");
    insert("save-as content");

    saveAsTo(target);
    let snapshot = waitUntil(() => {
      const current = state();
      return current.tabs.some((tab) => tab.label === "n8-saved.txt") ? current : null;
    }, 20000);

    check("N8", "the Tab renames after a successful Save As", Boolean(snapshot), snapshot ? labels(snapshot) : "timed out");
    check("N8", "the file exists on disk", existsSync(target));
    check("N8", "the written bytes match the document", existsSync(target) && readFileSync(target, "utf8") === "save-as content", existsSync(target) ? JSON.stringify(readFileSync(target, "utf8")) : "missing");
    check("N8", "the Tab is clean after saving", snapshot ? snapshot.tabs.find((tab) => tab.label === "n8-saved.txt")?.dirty === false : false);
  },

  n5() {
    insert("keep me");
    openPath(SMALL_A);
    const snapshot = waitUntil(() => {
      const current = state();
      return current.tabs.some((tab) => tab.label === "small-a.txt") ? current : null;
    }, 20000);

    check("N5", "the opened file appears as a Tab", Boolean(snapshot), snapshot ? labels(snapshot) : "timed out");
    check("N5", "the previous document is not replaced", Boolean(snapshot) && snapshot.tabs[0].label === "Untitled1", snapshot ? labels(snapshot) : "");
    check("N5", "the opened Tab is active", Boolean(snapshot) && activeLabel(snapshot) === "small-a.txt");
    check("N5", "the first document kept its text", Boolean(snapshot) && snapshot.tabs[0].dirty === true);
  },

  n6() {
    // 10 requests through the picker, 10 through drag/drop, alternating.
    for (let request = 0; request < 20; request += 1) {
      if (request % 2 === 0) {
        openPath(SMALL_A);
      } else {
        drop(SMALL_A);
      }
      waitUntil(() => {
        const current = state();
        return current.tabs.some((tab) => tab.label === "small-a.txt") ? current : null;
      }, 20000);
    }

    const snapshot = state();
    const matches = snapshot.tabs.filter((tab) => tab.label === "small-a.txt");
    check("N6", "exactly one Tab represents the file", matches.length === 1, `matches=${matches.length}`);
    check("N6", "no duplicate session was created", snapshot.tabCount === 2, labels(snapshot));
    check("N6", "the file's Tab is active after each request", activeLabel(snapshot) === "small-a.txt");
    check("N6", "no unsaved prompt appeared", uia("list").includes("#32770") === false);
  },

  n7() {
    insert("keep me");
    openPath(SMALL_A);
    waitUntil(() => {
      const current = state();
      return current.tabs.some((tab) => tab.label === "small-a.txt") ? current : null;
    }, 20000);

    // A second document tries to Save As onto the already-open file.
    key("ctrl+n");
    insert("colliding content");
    key("ctrl+shift+s");
    waitForDialog("Save As");
    uia("set-path-and-accept", "-TitleContains", "Save As", "-ClassContains", "#32770", "-Value", SMALL_A, "-TimeoutSeconds", "15");

    // The shell confirms the overwrite first, because the file exists on disk.
    sleepSync(1000);
    uia("dismiss-extra-dialogs");
    sleepSync(800);

    const dialog = waitForDialog("Sorakada");
    check("N7", "the cross-document target is rejected with a message", Boolean(dialog), dialog ? "message box shown" : "no message box");
    if (dialog) {
      uia("click-first-button", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-TimeoutSeconds", "10");
    }
    sleepSync(800);

    const snapshot = state();
    const survivor = snapshot.tabs.find((tab) => tab.label === "Untitled2");
    check("N7", "the source Tab stays open", Boolean(survivor), labels(snapshot));
    check("N7", "the source Tab is still dirty", Boolean(survivor) && survivor.dirty === true);
    check("N7", "the source Tab did not adopt the path", Boolean(survivor) && survivor.path === "Untitled2", survivor ? survivor.path : "");
    check("N7", "the already-open document is unchanged", snapshot.tabs.some((tab) => tab.label === "small-a.txt"));
  },

  n9() {
    // Save: writes, then closes.
    const target = freshTarget("n9-saved.txt");
    insert("n9 save path");
    saveAsTo(target);
    waitUntil(() => (state().tabs.some((tab) => tab.label === "n9-saved.txt") ? true : null), 20000);

    insert(" more text");
    key("ctrl+w");
    waitForDialog("Sorakada");
    uia("unsaved", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-Name", "save", "-TimeoutSeconds", "10");
    sleepSync(1200);

    let snapshot = state();
    check("N9", "Save writes and then closes the Tab", !snapshot.tabs.some((tab) => tab.label === "n9-saved.txt"), labels(snapshot));
    check("N9", "the saved file holds the latest text", existsSync(target) && readFileSync(target, "utf8") === "n9 save path more text", existsSync(target) ? JSON.stringify(readFileSync(target, "utf8")) : "missing");

    // Don't Save: closes without writing.
    const untouched = freshTarget("n9-untouched.txt");
    insert("first version");
    saveAsTo(untouched);
    waitUntil(() => (state().tabs.some((tab) => tab.label === "n9-untouched.txt") ? true : null), 20000);

    insert(" second version");
    key("ctrl+w");
    waitForDialog("Sorakada");
    uia("unsaved", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-Name", "dontSave", "-TimeoutSeconds", "10");
    sleepSync(1200);

    snapshot = state();
    check("N9", "Don't Save closes the Tab", !snapshot.tabs.some((tab) => tab.label === "n9-untouched.txt"), labels(snapshot));
    check("N9", "Don't Save leaves the file untouched", existsSync(untouched) && readFileSync(untouched, "utf8") === "first version", existsSync(untouched) ? JSON.stringify(readFileSync(untouched, "utf8")) : "missing");

    // Cancel: keeps the Tab and its content.
    insert("cancel me");
    key("ctrl+w");
    waitForDialog("Sorakada");
    uia("unsaved", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-Name", "cancel", "-TimeoutSeconds", "10");
    sleepSync(1200);

    snapshot = state();
    check("N9", "Cancel keeps the Tab open", snapshot.tabs.some((tab) => tab.dirty === true), labels(snapshot));
    check("N9", "Cancel keeps the content", snapshot.editor.text.includes("cancel me"), JSON.stringify(snapshot.editor.text.slice(0, 24)));
    check("N9", "Cancel leaves no dialog behind", !uia("list").includes("#32770") || !uia("list").includes("Sorakada'"));
  },

  n10() {
    insert("dirty A");
    key("ctrl+n");
    insert("dirty B");
    const before = state();
    check("N10", "two Tabs exist with B active", before.tabCount === 2 && activeLabel(before) === "Untitled2", labels(before));

    // Close A through its own close button while B stays active.
    clickSelector('.tab[title="Untitled1"] .tab__close');
    waitForDialog("Sorakada");
    uia("unsaved", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-Name", "dontSave", "-TimeoutSeconds", "10");
    sleepSync(1200);

    const after = state();
    check("N10", "the inactive Tab closed", !after.tabs.some((tab) => tab.label === "Untitled1"), labels(after));
    check("N10", "the active Tab never changed", activeLabel(after) === "Untitled2", activeLabel(after));
    check("N10", "the active Tab kept its own text", after.editor.text === "dirty B", JSON.stringify(after.editor.text));
  },

  n12() {
    insert("dirty one");
    key("ctrl+n");
    insert("dirty two");
    key("ctrl+n");
    insert("dirty three");
    const before = state();
    check("N12", "three dirty Tabs exist", before.tabCount === 3 && before.tabs.every((tab) => tab.dirty), labels(before));

    // Ask the window to close, then cancel at the second prompt.
    uia("close", "-TitleContains", "Sorakada", "-ClassContains", "Tauri Window");
    waitForDialog("Sorakada");
    uia("unsaved", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-Name", "dontSave", "-TimeoutSeconds", "10");
    sleepSync(800);
    waitForDialog("Sorakada");
    uia("unsaved", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-Name", "cancel", "-TimeoutSeconds", "10");
    sleepSync(1500);

    const after = state();
    check("N12", "the window is still open", after.tabs.length > 0, labels(after));
    check("N12", "no Tab was removed by the aborted exit", after.tabCount === 3, labels(after));
    check("N12", "no replacement Untitled was created", labels(after) === "Untitled1,Untitled2,Untitled3", labels(after));
    check("N12", "the app is still usable", after.editor.focused === true || after.activeElement === "DIV.cm-content", after.activeElement);
  },

  n13() {
    insert("dirty one");
    key("ctrl+n");
    insert("dirty two");

    uia("close", "-TitleContains", "Sorakada", "-ClassContains", "Tauri Window");
    for (let prompt = 0; prompt < 2; prompt += 1) {
      waitForDialog("Sorakada");
      uia("unsaved", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-Name", "dontSave", "-TimeoutSeconds", "10");
      sleepSync(800);
    }
    sleepSync(2500);

    // Any Tauri window would match loosely, so look for this application only:
    // its window title always ends with the product name, and its process must
    // be gone too.
    const listing = uia("list");
    const sorakadaWindow = listing
      .split("\n")
      .some((line) => line.includes("Tauri Window") && line.includes("Sorakada"));
    const processes = execFileSync("tasklist", ["/FI", "IMAGENAME eq sorakada.exe", "/NH"], {
      encoding: "utf8",
      timeout: 20000,
    });

    check("N13", "the window was destroyed after every prompt was approved", !sorakadaWindow, sorakadaWindow ? "Sorakada window still listed" : "window gone");
    check("N13", "the application process exited", !processes.includes("sorakada.exe"), processes.trim().split("\n")[0] ?? "");
    check("N13", "no extra window was left behind", !listing.includes("Save As") && !listing.includes("Open File"));
  },

  n14() {
    // valid, invalid binary, a folder, another valid file.
    drop(SMALL_A, BINARY, AI_DIR, SMALL_B);

    // The binary failure raises a message box the batch waits on.
    const dialog = waitForDialog("Sorakada", "#32770", 30000);
    check("N14", "the failure is reported without aborting the batch", Boolean(dialog), dialog ? "message box shown" : "no message box");
    if (dialog) {
      uia("click-first-button", "-TitleContains", "Sorakada", "-ClassContains", "#32770", "-TimeoutSeconds", "10");
    }

    const snapshot = waitUntil(() => {
      const current = state();
      return current.tabs.some((tab) => tab.label === "small-b.txt") ? current : null;
    }, 30000);

    check("N14", "later valid files still open", Boolean(snapshot), snapshot ? labels(snapshot) : "timed out");
    check("N14", "valid files keep the dropped order", Boolean(snapshot) && snapshot.tabs.filter((tab) => tab.path !== "Untitled1").map((tab) => tab.label).join(",") === "small-a.txt,small-b.txt", snapshot ? labels(snapshot) : "");
    check("N14", "the folder is ignored", Boolean(snapshot) && !snapshot.tabs.some((tab) => tab.label === "a-folder"));
    check("N14", "the last handled document is active", Boolean(snapshot) && activeLabel(snapshot) === "small-b.txt", snapshot ? activeLabel(snapshot) : "");
    check("N14", "the drop overlay cleared", Boolean(snapshot) && snapshot.dragOverlay === false);
  },

  n17() {
    const original = readFileSync(BOM_CRLF);
    openPath(BOM_CRLF);
    const snapshot = waitUntil(() => {
      const current = state();
      return current.tabs.some((tab) => tab.label === "utf8bom-crlf.txt") ? current : null;
    }, 20000);
    check("N17", "the BOM/CRLF fixture opens", Boolean(snapshot), snapshot ? labels(snapshot) : "timed out");

    // Save without edits: the bytes must be identical.
    key("ctrl+s");
    sleepSync(2000);
    const after = readFileSync(BOM_CRLF);

    check("N17", "an untouched save preserves the BOM", after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf, Array.from(after.slice(0, 3)).join(","));
    check("N17", "an untouched save preserves CRLF", after.includes(Buffer.from("\r\n")));
    check("N17", "the bytes are identical", Buffer.compare(original, after) === 0, `${original.length} vs ${after.length} bytes`);
  },
};

const group = process.argv[2];

if (!group || !groups[group]) {
  console.error(`Usage: node checklist-native.mjs <${Object.keys(groups).join("|")}>`);
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
