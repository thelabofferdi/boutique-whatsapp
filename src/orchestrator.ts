import type { AppConfig } from "./config.ts";
import type { ShopApi } from "./shop/api.ts";
import { runSolo, runTeam } from "./agent/loop.ts";
import type { RunResult } from "./agent/loop.ts";
import type { Trace } from "./types.ts";
import { maskPhone } from "./agent/guardrails.ts";
import { fmtXof } from "./format.ts";

/**
 * Orchestrateur commun au Worker WhatsApp et au CLI :
 * - verrou par conversation (deux messages rapprochés ne se croisent pas) ;
 * - trace gardée en mémoire (50 dernières) pour l'interface de démo ;
 * - validation gérante traitée comme un événement séparé, jamais par le LLM client.
 */

export type AgentMode = "solo" | "equipe";

const traces = new Map<string, Trace>();
const locks = new Map<string, Promise<unknown>>();

export function recentTraces(n = 20): Trace[] {
  return [...traces.values()].slice(-n).reverse();
}
export function getTrace(id: string): Trace | undefined {
  return traces.get(id);
}
export function rememberTrace(trace: Trace): void {
  traces.set(trace.id, trace);
  if (traces.size > 50) {
    const oldest = traces.keys().next().value;
    if (oldest) traces.delete(oldest);
  }
}

async function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(chatId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(chatId, settled);
  try {
    return await run;
  } finally {
    if (locks.get(chatId) === settled) locks.delete(chatId);
  }
}

export type Delivery = {
  send: (chatId: string, text: string) => Promise<void>;
  notifyManager: (text: string) => Promise<void>;
};

export async function answerCustomer(opts: {
  cfg: AppConfig;
  shop: ShopApi;
  chatId: string;
  text: string;
  name?: string;
  phone?: string;
  scenario?: string;
  mode?: AgentMode;
  delivery: Delivery;
}): Promise<{ reply: string; trace: Trace; result: RunResult }> {
  const { cfg, shop, chatId, text, delivery } = opts;
  const mode: AgentMode = opts.mode ?? cfg.agentMode;
  if (!(await shop.rateOk(chatId))) {
    const reply = "Tu m'as envoyé beaucoup de messages d'un coup 😅 Je prends le temps de vérifier et je te réponds dans un instant.";
    await delivery.send(chatId, reply);
    const trace = fakeTrace(reply, "limite de débit");
    rememberTrace(trace);
    return { reply, trace, result: { reply, trace, orders: [] } };
  }

  await shop.setLastCustomerText(chatId, text);
  await shop.pushOutbox(chatId, text, "client", "in");

  const open = (await shop.listOrders()).find(
    (o) => o.chat_id === chatId && (o.status === "brouillon" || o.status === "attente_gerante"),
  );
  const orderContext = open
    ? [
        "COMMANDE EN COURS POUR CE CLIENT :",
        `- code ${open.code} (${open.id}), statut ${open.status}`,
        `- ${open.lines.map((l) => `${l.quantity} × ${l.name}`).join(", ")}`,
        `- total ${open.total_xof} FCFA (articles ${open.subtotal_xof} + livraison ${open.delivery_xof}), zone ${open.zone}`,
        `- réservation jusqu'à ${open.reserved_until}`,
        open.status === "brouillon"
          ? "Si le client dit oui explicitement, appelle confirm_order avec ce code — ne refais pas de devis."
          : "La commande attend la validation de la gérante : rassure le client, ne recrée rien.",
      ].join("\n")
    : "";

  const run = mode === "solo" ? runSolo : runTeam;
  const result = await withChatLock(chatId, () =>
    run({
      cfg,
      shop,
      chatId,
      userText: text,
      customerName: opts.name,
      customerPhone: opts.phone,
      scenario: opts.scenario,
      orderContext,
      notifyManager: delivery.notifyManager,
    }),
  );

  await delivery.send(chatId, result.reply);
  rememberTrace(result.trace);
  return { reply: result.reply, trace: result.trace, result };
}

export async function handleManagerReply(opts: {
  cfg: AppConfig;
  shop: ShopApi;
  text: string;
  delivery: Delivery;
  from: string;
}): Promise<string> {
  const { cfg, shop, text, delivery } = opts;
  const cleaned = text.trim();
  const m = cleaned.match(/^\s*(oui|ok|valide|confirme|non|refuse|annule)\s*[:\-]?\s*([A-Z0-9]{4,})?\b/i);
  const decisionWord = (m?.[1] ?? "").toLowerCase();
  const code = (m?.[2] ?? "").toUpperCase();

  if (!decisionWord) {
    const pending = (await shop.listOrders()).filter((o) => o.status === "attente_gerante");
    const help = pending.length
      ? `Commandes en attente :\n${pending.map((o) => `• ${o.code} — ${o.customer_name}, ${fmtXof(o.total_xof)} FCFA`).join("\n")}\n\nRéponds *OUI CODE* ou *NON CODE*.`
      : "Aucune commande en attente. Les nouvelles commandes arrivent ici automatiquement.";
    await delivery.notifyManager(help);
    return help;
  }

  let order = code ? await shop.getOrder(code) : null;
  if (!order) {
    const pending = (await shop.listOrders()).filter((o) => o.status === "attente_gerante");
    if (pending.length === 1) order = pending[0];
    else {
      const msg = pending.length
        ? `Précise le code :\n${pending.map((o) => `• OUI ${o.code} (${fmtXof(o.total_xof)} FCFA)`).join("\n")}`
        : "Aucune commande en attente.";
      await delivery.notifyManager(msg);
      return msg;
    }
  }

  const decision: "confirmer" | "refuser" = /^(oui|ok|valide|confirme)$/i.test(decisionWord) ? "confirmer" : "refuser";
  try {
    const updated = await shop.managerDecision(order.id, decision, `gérante ${maskPhone(opts.from)}`);
    if (updated.status === "confirmee") {
      const clientMsg = [
        `✅ *Commande ${updated.code} confirmée !*`,
        `Merci ${updated.customer_name} 🙏`,
        `Articles : ${fmtXof(updated.subtotal_xof)} FCFA`,
        `Livraison : ${fmtXof(updated.delivery_xof)} FCFA`,
        `*Total : ${fmtXof(updated.total_xof)} FCFA*`,
        ``,
        `La gérante te contacte pour le paiement Mobile Money et la livraison.`,
      ].join("\n");
      await delivery.send(updated.chat_id, clientMsg);
      const mgrMsg = `✅ ${updated.code} validée. Le client a été prévenu. Pense à organiser la livraison (${updated.zone}).`;
      await delivery.notifyManager(mgrMsg);
      return mgrMsg;
    }
    const clientMsg = `😔 La gérante n'a pas pu valider la commande ${updated.code} (${updated.manager_note || "indisponible"}). Je te propose un autre article ou un autre créneau 🙏`;
    await delivery.send(updated.chat_id, clientMsg);
    await delivery.notifyManager(`❌ ${updated.code} refusée. Le client est informé.`);
    return `❌ ${updated.code} refusée.`;
  } catch (err) {
    const msg = `⚠️ Impossible de traiter ${order.code} : ${(err as Error).message}`;
    await delivery.notifyManager(msg);
    return msg;
  }
}

function fakeTrace(reply: string, reason: string): Trace {
  return {
    id: crypto.randomUUID(),
    architecture: "solo",
    started_at: new Date().toISOString(),
    duration_ms: 0,
    steps: [],
    tokens_in: 0,
    tokens_out: 0,
    cost_rodi: 0,
    cost_xof: 0,
    reply,
    checks: [{ name: "garde-fou", ok: false, detail: reason }],
  };
}
