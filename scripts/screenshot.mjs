#!/usr/bin/env node
/**
 * Captures d'écran de l'interface de démo via Chrome DevTools Protocol (aucune dépendance).
 *   node scripts/screenshot.mjs [url] [outDir]
 * Pilote le vrai Worker local (ou déployé) : messages client, validation gérante, captures.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const URL_BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "docs/captures";
const PORT = 9223;
const CHROME = process.env.CHROME || "google-chrome";

const CHAT = "22997000000@c.us";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=/tmp/opencode/chrome-shots`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--window-size=1680,1080",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  chrome.unref();
  await sleep(2500);

  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const target = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_BASE)}`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const once = (method) =>
    new Promise((resolve) => {
      const arr = listeners.get(method) ?? [];
      const fn = (p) => {
        listeners.set(method, (listeners.get(method) ?? []).filter((f) => f !== fn));
        resolve(p);
      };
      arr.push(fn);
      listeners.set(method, arr);
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1080, deviceScaleFactor: 2, mobile: false });
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url: URL_BASE });
  await loaded;
  await sleep(1500);

  async function shot(name) {
    await sleep(800);
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const path = `${OUT}/${name}.png`;
    await writeFile(path, Buffer.from(data, "base64"));
    console.log("📸", path);
  }

  async function chat(text) {
    await evaluate(
      `(() => { const i=document.getElementById('msg'); i.value=${JSON.stringify(text)}; send(); return true })()`,
    );
    for (let i = 0; i < 240; i++) {
      const busy = await evaluate("typeof busy !== 'undefined' && (busy === true || pending.length > 0)");
      if (!busy) break;
      await sleep(700);
    }
    await sleep(1500);
  }

  // Démo propre
  await fetch(`${URL_BASE}/api/reset`, { method: "POST" });
  await send("Page.reload", { ignoreCache: true });
  await sleep(2000);
  await evaluate("(() => { document.getElementById('modeSelect').value='solo'; setMode(); return true })()");
  await shot("01-accueil");

  await chat("Bonjour Awa ! Je veux 1 pagne Uniwax rouge et 2 foulards or, livraison à Fidjrossè. Je paie en euros, ça fait combien ?");
  await shot("02-devis");

  await chat("Oui je confirme, on y va.");
  for (let i = 0; i < 30; i++) {
    const st = await (await fetch(`${URL_BASE}/api/state`)).json();
    if (st.orders.some((o) => o.status === "attente_gerante")) break;
    await sleep(1000);
  }
  await shot("03-attente-gerante");

  await evaluate(
    `(async()=>{ const r=await fetch('/api/manager',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orderId:(state.orders.find(o=>o.status==='attente_gerante')||{}).id, decision:'confirmer'})}); await load(); return r.ok })()`,
  );
  await sleep(1500);
  await shot("04-commande-confirmee");

  // Vue mobile du téléphone client (pour le README)
  await send("Emulation.setDeviceMetricsOverride", { width: 430, height: 900, deviceScaleFactor: 3, mobile: true });
  await sleep(1200);
  await shot("05-telephone-client");

  ws.close();
  try {
    process.kill(-chrome.pid);
  } catch {}
  console.log("Terminé.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
