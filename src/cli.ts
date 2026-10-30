#!/usr/bin/env node
/**
 * CLI locale (paliers 1 et 2) :
 *   node src/cli.ts chat [--mode solo|equipe] [--fresh]
 *   node src/cli.ts demo
 *   node src/cli.ts bench [--modes solo,equipe] [--only commande_eur]
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, requireLlmConfig } from "./config.ts";
import { ShopCore } from "./shop/core.ts";
import { FileStore } from "./shop/file.ts";
import { LocalShopApi } from "./shop/api.ts";
import { answerCustomer, handleManagerReply, type AgentMode } from "./orchestrator.ts";
import { SCENARIOS } from "./bench/scenarios.ts";
import type { Trace } from "./types.ts";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* .env absent : les variables d'environnement priment */
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const CHAT = "22997000000@c.us";

function banner(shop: string, mode: AgentMode, model: string): void {
  console.log("");
  console.log(C.bold(C.green("  🧵 Boutique WhatsApp — Chez Maman Adjovi")));
  console.log(C.dim(`  Marché Dantokpa, Cotonou · architecture ${mode} · modèle ${model}`));
  console.log(C.dim("  Tape ton message comme un client. Commandes : /mode, /etat, /reset, /trace, /quit"));
  console.log("");
}

async function makeShop(file: string, fresh: boolean, mode: AgentMode, cfg: ReturnType<typeof loadConfig>) {
  if (fresh) await rm(file, { force: true });
  const core = await new ShopCore(new FileStore(file)).init();
  const print = async (chatId: string, text: string) => {
    if (chatId === cfg.managerChatId) {
      console.log(C.yellow("\n📲 Message reçu par la gérante :"));
      console.log(C.yellow(text));
    } else {
      console.log(C.green("\n🤖 Awa :"));
      console.log(text);
    }
  };
  const shop = new LocalShopApi(core, print);
  return { core, shop, print };
}

function traceSummary(t: Trace): void {
  const tools = t.steps.filter((s) => s.kind === "tool");
  console.log(
    C.dim(
      `  ── ${t.architecture} · ${(t.duration_ms / 1000).toFixed(1)} s · ${tools.length} outils · ${t.tokens_in + t.tokens_out} tokens · ${t.cost_xof.toFixed(1)} FCFA`,
    ),
  );
  for (const s of t.steps) {
    if (s.kind === "tool") console.log(C.dim(`     ⚙ ${s.name} (${s.ms} ms) → ${JSON.stringify(s.output).slice(0, 110)}`));
    else if (s.agent && s.agent !== "vendeuse" && s.agent !== "responsable") console.log(C.dim(`     🧠 ${s.agent} (${s.ms} ms)`));
  }
  const ko = t.checks.filter((c) => !c.ok);
  console.log(
    ko.length ? C.red(`     ✕ ${ko.map((c) => `${c.name}: ${c.detail}`).join(" | ")}`) : C.green("     ✓ garde-fous OK"),
  );
}

async function chat(modeArg?: AgentMode, fresh = false): Promise<void> {
  const cfg = loadConfig(process.env);
  requireLlmConfig(cfg);
  let mode: AgentMode = modeArg ?? cfg.agentMode;
  const { shop, core } = await makeShop("data/runtime/shop.json", fresh, mode, cfg);
  const { notifyManager } = { notifyManager: async (text: string) => console.log(C.yellow("\n📲 Notification gérante :\n" + text)) };
  const delivery = { send: async (chatId: string, text: string) => shop.deliverFn(chatId, text), notifyManager };
  banner(cfg.shopName, mode, cfg.model);
  const rl = createInterface({ input: stdin, output: stdout });

  while (true) {
    const line = (await rl.question(C.cyan("\n👤 Client : "))).trim();
    if (!line) continue;
    if (line === "/quit" || line === "/q") break;
    if (line.startsWith("/mode")) {
      mode = line.includes("solo") ? "solo" : "equipe";
      console.log(C.dim(`architecture → ${mode}`));
      continue;
    }
    if (line === "/reset") {
      await core.reset();
      console.log(C.dim("démo réinitialisée"));
      continue;
    }
    if (line === "/etat") {
      console.table((await core.listOrders()).map((o) => ({ code: o.code, client: o.customer_name, total: o.total_xof, statut: o.status })));
      console.table(core.products().map((p) => ({ id: p.id, article: p.name, prix: p.price_xof, stock: p.stock })));
      continue;
    }
    if (line === "/trace") {
      const last = (await core.listOrders()).at(-1);
      if (last) console.log(JSON.stringify(last, null, 2));
      continue;
    }
    if (/^(oui|non|ok|valide|confirme|refuse)\b/i.test(line) && (line.match(/[A-Z0-9]{4}/) || (await core.listOrders()).some((o) => o.status === "attente_gerante"))) {
      await handleManagerReply({ cfg, shop, text: line, delivery, from: cfg.managerPhone });
      continue;
    }
    const res = await answerCustomer({ cfg, shop, chatId: CHAT, text: line, name: "Client WhatsApp", phone: "97000000", mode, delivery });
    traceSummary(res.trace);
  }
  rl.close();
  await core.flush();
}

async function demo(modeArg?: AgentMode): Promise<void> {
  const cfg = loadConfig(process.env);
  requireLlmConfig(cfg);
  const scenario = SCENARIOS.find((s) => s.id === "commande_eur")!;
  const mode: AgentMode = modeArg ?? "equipe";
  const { shop, core } = await makeShop("data/runtime/shop.json", true, mode, cfg);
  const delivery = {
    send: async (chatId: string, text: string) => shop.deliverFn(chatId, text),
    notifyManager: async (text: string) => console.log(C.yellow("\n📲 Notification gérante :\n" + text)),
  };
  banner(cfg.shopName, mode, cfg.model);
  const traces: Trace[] = [];
  for (const turn of scenario.turns) {
    console.log(C.cyan("\n👤 Client : ") + turn);
    const res = await answerCustomer({ cfg, shop, chatId: CHAT, text: turn, name: "Awa Dossou", phone: "97000000", mode, delivery });
    traces.push(res.trace);
    traceSummary(res.trace);
  }
  const order = (await core.listOrders()).find((o) => o.status === "attente_gerante");
  if (order) {
    console.log(C.yellow(`\n👩🏾 Gérante : OUI ${order.code}`));
    await handleManagerReply({ cfg, shop, text: `OUI ${order.code}`, delivery, from: cfg.managerPhone });
  }
  await core.flush();
  await mkdir("traces", { recursive: true });
  const payload = { scenario: scenario.title, at: new Date().toISOString(), model: cfg.model, traces };
  await writeFile("traces/exemple-commande.json", JSON.stringify(payload, null, 2));
  console.log(C.dim("\nTrace complète écrite dans traces/exemple-commande.json"));
}

async function main(): Promise<void> {
  const [cmd = "chat", ...rest] = process.argv.slice(2);
  const modeArg = rest.includes("--mode") ? (rest[rest.indexOf("--mode") + 1] as AgentMode) : undefined;
  if (cmd === "chat") return chat(modeArg, rest.includes("--fresh"));
  if (cmd === "demo") return demo(modeArg);
  if (cmd === "bench") {
    const { runBench } = await import("./bench/run.ts");
    const modes = rest.includes("--modes") ? (rest[rest.indexOf("--modes") + 1].split(",") as AgentMode[]) : undefined;
    const only = rest.includes("--only") ? rest[rest.indexOf("--only") + 1].split(",") : undefined;
    const report = await runBench({ modes, only, verbose: true });
    console.log("\n" + report.verdict + "\n");
    console.log("→ bench/results.md");
    return;
  }
  console.log("Commandes : chat | demo | bench");
}

main().catch((err) => {
  console.error(C.red("Erreur : ") + (err as Error).message);
  process.exit(1);
});
