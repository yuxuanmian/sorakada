/**
 * N18: the browser-only smoke check (quickstart §13).
 *
 * The Vite dev server must already be up (run-group.ps1 starts it as part of
 * `tauri dev`). This launches a headless Chromium against the same page the
 * desktop shell loads, so the application runs with no Tauri bridge at all.
 *
 * Usage:
 *   node checklist-browser.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "cdp.mjs");
const APP_URL = "http://localhost:1420/";
const DEBUG_PORT = 9223;

const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const results = [];

function check(id, description, condition, detail = "") {
  const pass = Boolean(condition);
  results.push({ id, description, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${description}${detail ? `  :: ${detail}` : ""}`);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitUntil(probe, timeoutMs = 20000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    sleepSync(intervalMs);
  }
}

/** Runs cdp.mjs against the browser's debugging port. */
function cdp(...args) {
  const output = execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 25000,
    env: { ...process.env, CDP_PORT: String(DEBUG_PORT) },
  });
  return JSON.parse(output);
}

const browserPath = BROWSERS.find((candidate) => existsSync(candidate));
if (!browserPath) {
  console.log("SKIP  N18  no Chromium-based browser found");
  process.exit(0);
}

const profileDir = mkdtempSync(join(tmpdir(), "sorakada-browser-"));
const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1200,780",
    APP_URL,
  ],
  { stdio: "ignore", detached: false },
);

try {
  // The app has to be served and rendered before anything can be asserted.
  const target = waitUntil(() => {
    try {
      const response = execFileSync(
        process.execPath,
        [
          "-e",
          `fetch("http://127.0.0.1:${DEBUG_PORT}/json/list").then(r=>r.json()).then(t=>{const p=t.find(x=>x.type==="page"&&x.url.includes("1420"));console.log(p?p.url:"")}).catch(()=>console.log(""))`,
        ],
        { encoding: "utf8", timeout: 8000 },
      ).trim();
      return response || null;
    } catch {
      return null;
    }
  }, 40000, 1000);

  check("N18", "the Vite page is served and loaded by a plain browser", Boolean(target), target ?? "no page target");

  // Give the React tree a moment to mount.
  sleepSync(1500);

  const snapshot = cdp("state");

  check("N18", "the Tab strip renders", snapshot.tabCount === 1, `${snapshot.tabCount} tab(s)`);
  check("N18", "the initial Tab is Untitled1", snapshot.tabs[0]?.label === "Untitled1", snapshot.tabs[0]?.label ?? "");
  check("N18", "the editor renders", snapshot.editor.lineCount >= 1, `lineCount=${snapshot.editor.lineCount}`);
  check("N18", "the editor is focused", snapshot.editor.focused === true, snapshot.activeElement);

  const bridge = cdp("eval", "typeof window.__TAURI_INTERNALS__");
  check("N18", "no Tauri bridge is present", bridge === "undefined", String(bridge));

  // The native surfaces are gated on that bridge, so none of them installed.
  const dropOverlay = snapshot.dragOverlay;
  check("N18", "no native drag/drop affordance was installed", dropOverlay === false);

  // Tab behaviour that needs no OS integration must still work.
  //
  // Ctrl+N cannot be injected as a raw key here: it is a Chromium accelerator
  // for "new window", so the browser would open one and the CDP client would
  // follow it. The event is dispatched into the page instead, which exercises
  // the application's own keydown dispatcher without the browser's default
  // action. (A real browser-only user does hit that collision; see the report.)
  const pageUrl = cdp("eval", "location.href");
  check("N18", "the page under test is still the application", pageUrl.startsWith(APP_URL), String(pageUrl));

  cdp(
    "eval",
    "(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()",
  );
  sleepSync(600);
  const afterNew = cdp("state");

  if (afterNew.tabCount !== 2) {
    const dom = cdp(
      "eval",
      "JSON.stringify({app:Boolean(document.querySelector('.app')),bar:Boolean(document.querySelector('.tab-bar')),editor:Boolean(document.querySelector('.cm-content')),labels:[...document.querySelectorAll('.tab__label')].map(e=>e.textContent),body:(document.body.innerText||'').slice(0,300)})",
    );
    console.log(`  diagnostic after Ctrl+N: ${dom}`);
  }

  check("N18", "Tab creation still works without the bridge", afterNew.tabCount === 2, `${afterNew.tabCount} tab(s)`);
  check("N18", "the new Tab is Untitled2", afterNew.tabs[1]?.label === "Untitled2", afterNew.tabs[1]?.label ?? "");
  check("N18", "the page did not crash", typeof snapshot.title === "string");
} catch (error) {
  check("N18", "the browser-only session survived", false, error.message);
} finally {
  try {
    browser.kill();
  } catch {
    // Already gone.
  }
  sleepSync(800);
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // A locked profile directory is harmless for the result.
  }
}

const failed = results.filter((entry) => !entry.pass);
console.log("");
console.log(`group n18: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
