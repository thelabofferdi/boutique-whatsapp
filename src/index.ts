import ui from "./web/index.html";
import { loadConfig, greenApiConfigured, type AppConfig } from "./config.ts";
import { ShopDO, RemoteShopApi } from "./shop/do.ts";
import { parseGreenApi, sendGreenApi, setTyping, webhookAuthorized } from "./channels/greenapi.ts";
import {
  answerCustomer,
  getTrace,
  handleManagerReply,
  recentTraces,
  type Delivery,
} from "./orchestrator.ts";

export { ShopDO };

const SHOP_ID = "dantokpa";

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function shopFor(env: Env): RemoteShopApi {
  return new RemoteShopApi(env.SHOP.get(env.SHOP.idFromName(SHOP_ID)));
}

function deliveryFor(env: Env, cfg: AppConfig, shop: RemoteShopApi): Delivery {
  const send = async (chatId: string, text: string) => {
    await shop.pushOutbox(chatId, text, chatId === cfg.managerChatId ? "gerante" : "client", "out");
    // Les conversations de démonstration restent dans le simulateur : on n'envoie pas de WhatsApp réel.
    const isDemoChat = chatId.startsWith("22997000000") || chatId.startsWith("22990000001");
    if (greenApiConfigured(cfg) && !isDemoChat) {
      try {
        await sendGreenApi(cfg, chatId, text);
      } catch (err) {
        console.error("Green API:", (err as Error).message);
      }
    }
  };
  return {
    send,
    notifyManager: (text: string) => send(cfg.managerChatId, text),
  };
}

function demoAuthorized(req: Request, url: URL, env: Env): boolean {
  const token = env.DEMO_TOKEN;
  if (!token) return true;
  return url.searchParams.get("token") === token || req.headers.get("x-demo-token") === token;
}

async function processIncoming(env: Env, cfg: AppConfig, shop: RemoteShopApi, payload: unknown): Promise<void> {
  const msg = parseGreenApi(payload, cfg);
  if (!msg) return;
  if (msg.isGroup) return;
  if (msg.id && (await shop.isDuplicate(msg.id))) return;

  const delivery = deliveryFor(env, cfg, shop);
  if (msg.fromManager) {
    await shop.pushOutbox(cfg.managerChatId, msg.text, "gerante", "in");
    await handleManagerReply({ cfg, shop, text: msg.text, delivery, from: msg.phone });
    return;
  }

  await setTyping(cfg, msg.chatId, 5).catch(() => {});
  await answerCustomer({
    cfg: cfg.simulator ? { ...cfg, agentMode: cfg.agentMode } : cfg,
    shop,
    chatId: msg.chatId,
    text: msg.text,
    name: msg.name,
    phone: msg.phone,
    delivery,
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const cfg = loadConfig(env as unknown as Record<string, string | undefined>);
    const shop = shopFor(env);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        shop: cfg.shopName,
        mode: cfg.agentMode,
        model: cfg.model,
        whatsapp: greenApiConfigured(cfg) ? "green-api" : "simulateur",
        time: new Date().toISOString(),
      });
    }

    // --- Webhook Green API : réponse immédiate, traitement en arrière-plan -----------------
    if (url.pathname.startsWith("/webhook/greenapi")) {
      if (req.method !== "POST") return json({ ok: false, error: "POST attendu" }, 405);
      if (!webhookAuthorized(req, url, cfg)) return json({ ok: false, error: "webhook non autorisé" }, 401);
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return json({ ok: true, ignored: "json invalide" });
      }
      ctx.waitUntil(processIncoming(env, cfg, shop, payload).catch((err) => console.error("webhook:", err)));
      return json({ ok: true }); // < 1 s : Green API ne réessaie pas inutilement
    }

    if (url.pathname.startsWith("/api/") && !demoAuthorized(req, url, env)) {
      return json({ ok: false, error: "token de démo requis" }, 401);
    }

    // --- Démo navigateur ------------------------------------------------------------------
    if (url.pathname === "/api/state" && req.method === "GET") {
      const [products, orders, outbox] = await Promise.all([shop.products(), shop.listOrders(), shop.outbox()]);
      return json({
        ok: true,
        shop: { name: cfg.shopName, city: cfg.shopCity, mode: cfg.agentMode, model: cfg.model, whatsapp: greenApiConfigured(cfg) ? "green-api" : "simulateur" },
        products,
        orders,
        outbox,
        traces: recentTraces(12).map(traceSummary),
      });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { chatId?: string; text?: string; name?: string; mode?: "solo" | "equipe" };
      const text = (body.text ?? "").trim();
      if (!text) return json({ ok: false, error: "message vide" }, 400);
      const chatId = body.chatId || "22997000000@c.us";
      const started = Date.now();
      const result = await answerCustomer({
        cfg,
        shop,
        chatId,
        text,
        name: body.name || "Client démo",
        phone: chatId.split("@")[0],
        mode: body.mode,
        delivery: deliveryFor(env, cfg, shop),
      });
      return json({
        ok: true,
        reply: result.reply,
        trace_id: result.trace.id,
        duration_ms: Date.now() - started,
        checks: result.trace.checks,
        order: result.result.orders.at(-1) ?? null,
      });
    }

    if (url.pathname === "/api/manager" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { orderId?: string; decision?: "confirmer" | "refuser" };
      if (!body.orderId || !body.decision) return json({ ok: false, error: "orderId et decision requis" }, 400);
      const word = body.decision === "confirmer" ? "OUI" : "NON";
      const text = `${word} ${body.orderId}`;
      const msg = await handleManagerReply({ cfg, shop, text, delivery: deliveryFor(env, cfg, shop), from: cfg.managerPhone });
      return json({ ok: true, message: msg });
    }

    if (url.pathname.startsWith("/api/trace/") && req.method === "GET") {
      const trace = getTrace(url.pathname.split("/").pop() || "");
      return trace ? json({ ok: true, trace }) : json({ ok: false, error: "trace inconnue" }, 404);
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      const stub = env.SHOP.get(env.SHOP.idFromName(SHOP_ID));
      await stub.fetch("https://shop.internal/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "reset", args: [] }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: "route inconnue" }, 404);
  },
} satisfies ExportedHandler<Env>;

function traceSummary(t: ReturnType<typeof recentTraces>[number]) {
  const tools = t.steps.filter((s) => s.kind === "tool").map((s) => s.name);
  return {
    id: t.id,
    architecture: t.architecture,
    scenario: t.scenario,
    at: t.started_at,
    duration_ms: t.duration_ms,
    cost_xof: Math.round(t.cost_xof * 100) / 100,
    tokens: t.tokens_in + t.tokens_out,
    tools,
    ok: t.checks.every((c) => c.ok),
    reply: t.reply,
  };
}

function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-demo-token",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
}
