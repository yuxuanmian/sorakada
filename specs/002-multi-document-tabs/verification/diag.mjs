/**
 * Step-by-step CDP connectivity diagnostic with hard timeouts on every stage.
 *
 * Usage:  node diag.mjs
 *
 * Prints how long each stage took, so a hang can be attributed to the HTTP
 * endpoint, the WebSocket handshake, or Runtime.evaluate.
 */

const PORT = Number(process.env.CDP_PORT ?? 9222);
const BASE = `http://127.0.0.1:${PORT}`;

function stamp(label, startedAt, extra = "") {
  console.log(`${label}: ${Math.round(performance.now() - startedAt)} ms ${extra}`);
}

// 1. HTTP discovery.
let target;
{
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) });
    const targets = await response.json();
    stamp("http /json/list", started, `targets=${targets.length}`);
    target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    console.log(`  page target: ${target ? target.url : "(none)"}`);
    if (!target) {
      process.exit(1);
    }
  } catch (error) {
    stamp("http /json/list FAILED", started, error.message);
    process.exit(1);
  }
}

// 2. WebSocket handshake.
const started = performance.now();
const ws = new WebSocket(target.webSocketDebuggerUrl);
const opened = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 10000);
  ws.addEventListener("open", () => {
    clearTimeout(timer);
    resolve(true);
  });
  ws.addEventListener("error", () => {
    clearTimeout(timer);
    resolve(false);
  });
});
stamp("ws handshake", started, opened ? "OPEN" : "TIMEOUT/ERROR");

if (!opened) {
  ws.close();
  process.exit(1);
}

// 3. Runtime.evaluate with a timeout.
async function send(method, params = {}, timeoutMs = 10000) {
  const id = Math.floor(Math.random() * 1e9);
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(message);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return result;
}

for (const [method, params] of [
  ["Runtime.evaluate", { expression: "1+1", returnByValue: true }],
  ["Runtime.evaluate", { expression: "document.title", returnByValue: true }],
  ["Runtime.evaluate", { expression: "document.querySelectorAll('.tab').length", returnByValue: true }],
  ["Runtime.evaluate", { expression: "document.readyState", returnByValue: true }],
]) {
  const time = performance.now();
  const result = await send(method, params);
  if (result.timedOut) {
    stamp(`evaluate ${params.expression}`, time, "TIMED OUT");
  } else if (result.error) {
    stamp(`evaluate ${params.expression}`, time, `ERROR ${result.error.message}`);
  } else {
    stamp(`evaluate ${params.expression}`, time, `=> ${JSON.stringify(result.result?.result?.value ?? result.result)}`);
  }
}

ws.close();
console.log("done");
