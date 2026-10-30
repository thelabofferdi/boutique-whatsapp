#!/usr/bin/env node
/**
 * Coupe ou rallume les réponses WhatsApp du bot, sans redéploiement.
 *
 *   node scripts/whatsapp.mjs status   # état actuel
 *   node scripts/whatsapp.mjs pause    # le bot ne reçoit plus rien (aucune réponse)
 *   node scripts/whatsapp.mjs resume   # le bot répond de nouveau
 *
 * Le réglage est stocké dans Green API (incomingWebhook), pas dans le Worker :
 * il survit aux déploiements.
 */
import { readFileSync } from "node:fs";
import https from "node:https";

function loadEnv(file = ".env") {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

loadEnv();

const base = process.env.GREENAPI_BASE_URL;
const id = process.env.GREENAPI_ID_INSTANCE;
const token = process.env.GREENAPI_TOKEN;

if (!base || !id || !token) {
  console.error("GREENAPI_BASE_URL / GREENAPI_ID_INSTANCE / GREENAPI_TOKEN manquants (voir .env).");
  process.exit(1);
}

const api = (method) => `${base}/waInstance${id}/${method}/${token}`;

/** Requête HTTPS en IPv4 (fetch d'undici expire parfois sur cet hôte). */
function request(url, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        family: 4,
        timeout: 20_000,
        headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            reject(new Error(`réponse non JSON : ${data.slice(0, 120)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const settings = () => request(api("getSettings"));
const set = (payload) => request(api("setSettings"), { method: "POST", body: JSON.stringify(payload) });

async function main() {
  const cmd = process.argv[2] || "status";

  if (cmd === "status") {
    const s = await settings();
    const on = s.incomingWebhook === "yes";
    console.log(`Bot WhatsApp : ${on ? "ACTIF (il répond)" : "COUPÉ (aucune réponse)"}`);
    console.log(`  incomingWebhook = ${s.incomingWebhook}`);
    console.log(`  webhookUrl      = ${s.webhookUrl || "(vide)"}`);
    return;
  }

  if (cmd === "pause") {
    await set({ incomingWebhook: "no" });
    const s = await settings();
    console.log(`Bot coupé (incomingWebhook = ${s.incomingWebhook}). Plus aucune réponse WhatsApp.`);
    return;
  }

  if (cmd === "resume") {
    await set({ incomingWebhook: "yes" });
    const s = await settings();
    console.log(`Bot rallumé (incomingWebhook = ${s.incomingWebhook}).`);
    console.log(`Les messages arrivent sur : ${s.webhookUrl || "(webhook non configuré !)"}`);
    return;
  }

  console.log("Commandes : status | pause | resume");
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
