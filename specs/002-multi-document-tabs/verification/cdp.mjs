/**
 * Minimal Chrome DevTools Protocol driver for the Sorakada WebView2.
 *
 * Zero dependencies: Node's global `WebSocket` and `fetch` are enough. Kept in
 * the gitignored `specs/` tree so the repository itself gains no test tooling.
 *
 * Usage:
 *   node cdp.mjs targets
 *   node cdp.mjs state
 *   node cdp.mjs eval "<javascript expression>"
 *   node cdp.mjs key ctrl+shift+s
 *   node cdp.mjs insert "text to type"
 *   node cdp.mjs click "<css selector>"
 *   node cdp.mjs bench
 *   node cdp.mjs shot <output.png>
 *   node cdp.mjs wait 250
 *
 * The port defaults to 9222; override with CDP_PORT.
 */

const PORT = Number(process.env.CDP_PORT ?? 9222);
const BASE = `http://127.0.0.1:${PORT}`;

/** The page target that hosts the application. */
async function findPageTarget() {
  const response = await fetch(`${BASE}/json/list`);
  if (!response.ok) {
    throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  }
  const targets = await response.json();
  const page = targets.find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );
  if (!page) {
    throw new Error(
      `No page target with a debugger URL. Saw: ${JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url })))}`,
    );
  }
  return page;
}

class Session {
  #ws;
  #nextId = 1;
  #pending = new Map();

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", (event) => reject(event.error ?? new Error("WebSocket error")), {
        once: true,
      });
    });
    const session = new Session();
    session.#ws = ws;
    ws.addEventListener("message", (event) => session.#receive(event.data));
    return session;
  }

  #receive(raw) {
    const message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (message.id === undefined) {
      return;
    }
    const entry = this.#pending.get(message.id);
    if (!entry) {
      return;
    }
    this.#pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
      return;
    }
    entry.resolve(message.result);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`CDP timeout for ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    this.#ws.close();
  }
}

async function withSession(work) {
  const target = await findPageTarget();
  const session = await Session.connect(target.webSocketDebuggerUrl);
  try {
    await session.send("Runtime.enable");
    return await work(session);
  } finally {
    session.close();
  }
}

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  f5: { key: "F5", code: "F5", vk: 116 },
};

function parseChord(spec) {
  const parts = spec.toLowerCase().split("+");
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (bit === undefined) {
      throw new Error(`Unknown modifier "${part}" in "${spec}"`);
    }
    modifiers |= bit;
  }

  const named = NAMED_KEYS[name];
  if (named) {
    return { ...named, modifiers };
  }
  if (name.length !== 1) {
    throw new Error(`Unsupported key "${name}" in "${spec}"`);
  }

  const vk = name.toUpperCase().charCodeAt(0);
  return {
    key: name,
    code: /[a-z]/.test(name) ? `Key${name.toUpperCase()}` : `Digit${name}`,
    vk,
    modifiers,
  };
}

async function dispatchKey(session, spec) {
  const { key, code, vk, modifiers } = parseChord(spec);
  const base = {
    modifiers,
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };

  await session.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
  // A printable key still needs a `char` event for text insertion paths.
  if (key.length === 1 && (modifiers & (MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.meta)) === 0) {
    await session.send("Input.dispatchKeyEvent", {
      ...base,
      type: "keyDown",
      text: key,
      unmodifiedText: key,
    });
  }
  await session.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "evaluation failed";
    throw new Error(detail);
  }
  return result.result?.value;
}

async function elementCenter(session, selector) {
  const center = await evaluate(
    session,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  if (!center) {
    throw new Error(`No visible element matches ${selector}`);
  }
  return center;
}

async function dispatchClick(session, x, y) {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse",
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
}

async function clickSelector(session, selector) {
  const { x, y } = await elementCenter(session, selector);
  await dispatchClick(session, x, y);
  return { x, y };
}

/**
 * Clicks a Tab by its display name or its full path.
 *
 * Matching happens in JavaScript rather than through a CSS attribute selector,
 * because Windows paths contain backslashes that would need CSS escaping.
 */
async function clickTab(session, needle) {
  const center = await evaluate(
    session,
    `(() => {
      const wanted = ${JSON.stringify(needle)};
      const tabs = [...document.querySelectorAll('.tab')];
      const el = tabs.find((tab) =>
        (tab.getAttribute('title') || '') === wanted ||
        (tab.querySelector('.tab__label')?.textContent || '') === wanted,
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  if (!center) {
    throw new Error(`No Tab matches "${needle}"`);
  }
  await dispatchClick(session, center.x, center.y);
  return center;
}

async function screenshot(session, outputPath) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputPath, Buffer.from(data, "base64"));
  return outputPath;
}

const [command, ...args] = process.argv.slice(2);

/**
 * The observable application state, read straight from the DOM.
 *
 * Everything here is something the checklist can assert on: Tab labels, which
 * Tab is active, dirty markers, the document text the editor is showing, the
 * reading position, the Tab strip's overflow behaviour and whether the drag
 * overlay is up. No application internals are poked.
 */
const STATE_EXPRESSION = `(() => {
  const tabBar = document.querySelector('.tab-bar');
  const tabs = [...document.querySelectorAll('.tab')].map((el) => ({
    label: el.querySelector('.tab__label')?.textContent ?? null,
    active: el.classList.contains('tab--active'),
    dirty: Boolean(el.querySelector('.tab__dirty')),
    path: el.getAttribute('title'),
  }));
  const activeTab = document.querySelector('.tab--active');
  const content = document.querySelector('.cm-content');
  const scroller = document.querySelector('.cm-scroller');
  const editor = document.querySelector('.cm-editor');
  const cursor = document.querySelector('.cm-cursor');
  const barRect = tabBar ? tabBar.getBoundingClientRect() : null;
  const activeRect = activeTab ? activeTab.getBoundingClientRect() : null;
  const inView = Boolean(
    barRect && activeRect && activeRect.left >= barRect.left - 1 && activeRect.right <= barRect.right + 1,
  );
  const selection = window.getSelection();
  const active = document.activeElement;
  return {
    title: document.title,
    tabs,
    tabCount: tabs.length,
    dragOverlay: Boolean(document.querySelector('.drop-overlay')),
    activeElement: active ? active.tagName + '.' + String(active.className || '') : null,
    windowFocused: document.hasFocus(),
    editor: {
      text: content ? content.textContent : null,
      lineCount: document.querySelectorAll('.cm-line').length,
      scrollerTop: scroller ? Math.round(scroller.scrollTop) : null,
      scrollerLeft: scroller ? Math.round(scroller.scrollLeft) : null,
      cursorTop: cursor ? Math.round(cursor.getBoundingClientRect().top) : null,
      selectionText: selection ? String(selection) : null,
      focused: Boolean(editor && document.activeElement && editor.contains(document.activeElement)),
    },
    tabBar: barRect
      ? {
          clientWidth: Math.round(tabBar.clientWidth),
          scrollWidth: Math.round(tabBar.scrollWidth),
          scrollLeft: Math.round(tabBar.scrollLeft),
          activeInView: inView,
        }
      : null,
    benchmarkCount: window.sorakada?.benchmark ? window.sorakada.benchmark.results().length : null,
  };
})()`;

const BENCH_EXPRESSION = `(() => {
  const benchmark = window.sorakada?.benchmark;
  if (!benchmark) return { available: false };
  return {
    available: true,
    results: benchmark.results(),
    summary: benchmark.summarize(),
  };
})()`;

/**
 * Emits a native drag/drop event through Tauri's own event bus.
 *
 * This drives the exact listener and open pipeline the operating system's OLE
 * drop would drive; only the OS-level drag source is substituted. Provenance
 * matters, so the checklist records where this was used.
 */
function dragExpression(event, paths) {
  return `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
    event,
    payload: { paths, position: { x: 40, y: 40 } },
  })})`;
}

try {
  const output = await withSession(async (session) => {
    switch (command) {
      case "targets": {
        const response = await fetch(`${BASE}/json/list`);
        return await response.json();
      }
      case "state":
        return await evaluate(session, STATE_EXPRESSION);
      case "bench":
        return await evaluate(session, BENCH_EXPRESSION);
      case "eval":
        return await evaluate(session, args.join(" "));
      case "key":
        await dispatchKey(session, args[0]);
        return { sent: args[0] };
      case "insert":
        await session.send("Input.insertText", { text: args.join(" ") });
        return { inserted: args.join(" ") };
      case "dragenter":
        return await evaluate(session, dragExpression("tauri://drag-enter", args));
      case "dragleave":
        return await evaluate(session, dragExpression("tauri://drag-leave", []));
      case "drop":
        return await evaluate(session, dragExpression("tauri://drag-drop", args));
      case "click":
        return await clickSelector(session, args[0]);
      case "clicktab":
        return await clickTab(session, args.join(" "));
      case "bench-reset":
        return await evaluate(
          session,
          "(() => { window.sorakada?.benchmark?.reset(); return true; })()",
        );
      case "keylog-start":
        return await evaluate(
          session,
          `(() => {
            window.__dshKeys = [];
            if (!window.__dshKeyLogger) {
              window.__dshKeyLogger = (event) => {
                window.__dshKeys.push({
                  key: event.key,
                  ctrl: event.ctrlKey,
                  shift: event.shiftKey,
                  alt: event.altKey,
                  meta: event.metaKey,
                  trusted: event.isTrusted,
                });
              };
              window.addEventListener('keydown', window.__dshKeyLogger, true);
            }
            return true;
          })()`,
        );
      case "keylog-read":
        return await evaluate(session, "window.__dshKeys ?? null");
      case "shot":
        return await screenshot(session, args[0]);
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, Number(args[0] ?? 100)));
        return { waited: Number(args[0] ?? 100) };
      default:
        throw new Error(`Unknown command "${command}"`);
    }
  });

  // Exit explicitly once stdout has flushed. The WebSocket can keep the event
  // loop alive, and a CLI that never exits makes the caller block forever.
  const text = JSON.stringify(output ?? null, null, 2);
  process.stdout.write(`${text}\n`, () => process.exit(0));
} catch (error) {
  process.stderr.write(`CDP_ERROR: ${error.message}\n`, () => process.exit(1));
}
