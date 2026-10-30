import { DurableObject } from "cloudflare:workers";
import { ShopCore, type ShopState } from "./core.ts";
import type { ShopApi } from "./api.ts";
import type { ChatMessage, Order, Product } from "../types.ts";
import { quoteDelivery, zoneList } from "./delivery.ts";

/**
 * État unique de la boutique, sérialisé par un Durable Object :
 * - un seul fil d'exécution → pas de survente quand deux clients commandent en même temps ;
 * - stockage SQLite intégré → stock et commandes survivent aux redémarrages ;
 * - idempotence des messages Green API gérée au même endroit.
 */
export class ShopDO extends DurableObject {
  private core: ShopCore;
  ready: Promise<unknown>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new ShopCore({
      load: async () => (await ctx.storage.get<ShopState>("state")) ?? null,
      save: async (state) => {
        await ctx.storage.put("state", state);
      },
    });
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await this.core.init();
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/rpc" && request.method === "POST") {
      let body: { method?: string; args?: unknown[] };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ ok: false, error: "JSON invalide" }, 400);
      }
      const method = body.method ?? "";
      const allowed = new Set([
        "products", "search", "stockInfo", "available", "reserved",
        "createDraft", "customerConfirm", "managerDecision", "getOrder", "requireOrder", "listOrders",
        "lastCustomerText", "setLastCustomerText", "conversation", "appendConversation",
        "isDuplicate", "pushOutbox", "outbox", "rateOk", "isAffirmative", "reset", "flush", "expireDrafts",
      ]);
      if (!allowed.has(method)) return json({ ok: false, error: `méthode inconnue : ${method}` }, 400);
      try {
        const fn = (this.core as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
        const data = await fn.apply(this.core, body.args ?? []);
        return json({ ok: true, data });
      } catch (err) {
        return json({ ok: false, error: (err as Error).message }, 400);
      }
    }
    if (url.pathname === "/flush") {
      await this.core.flush();
      return json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Client DO côté Worker : chaque outil de l'agent passe par un RPC sérialisé. */
export class RemoteShopApi implements ShopApi {
  private stub: DurableObjectStub;

  constructor(stub: DurableObjectStub) {
    this.stub = stub;
  }

  private async rpc<T>(method: string, ...args: unknown[]): Promise<T> {
    const res = await this.stub.fetch("https://shop.internal/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, args }),
    });
    const payload = (await res.json()) as { ok: boolean; data?: T; error?: string };
    if (!payload.ok) throw new Error(payload.error || "Erreur boutique");
    return payload.data as T;
  }

  products(): Promise<Product[]> {
    return this.rpc("products");
  }
  searchProducts(query: string, opts: { category?: string; max_price_xof?: number } = {}): Promise<Product[]> {
    return this.rpc("search", query, opts);
  }
  stock(productId: string) {
    return this.rpc<Awaited<ReturnType<ShopCore["stockInfo"]>>>("stockInfo", productId);
  }
  createDraft(input: Parameters<ShopCore["createDraft"]>[0]) {
    return this.rpc<Order>("createDraft", input);
  }
  customerConfirm(orderId: string, customerText: string) {
    return this.rpc<Order>("customerConfirm", orderId, customerText);
  }
  getOrder(orderId: string) {
    return this.rpc<Order | null>("getOrder", orderId);
  }
  listOrders() {
    return this.rpc<Order[]>("listOrders");
  }
  managerDecision(orderId: string, decision: "confirmer" | "refuser", by: string, note = "") {
    return this.rpc<Order>("managerDecision", orderId, decision, by, note);
  }
  lastCustomerText(chatId: string) {
    return this.rpc<string>("lastCustomerText", chatId);
  }
  setLastCustomerText(chatId: string, text: string) {
    return this.rpc<void>("setLastCustomerText", chatId, text);
  }
  conversation(chatId: string) {
    return this.rpc<ChatMessage[]>("conversation", chatId);
  }
  appendConversation(chatId: string, messages: ChatMessage[]) {
    return this.rpc<void>("appendConversation", chatId, messages);
  }
  isDuplicate(messageId: string) {
    return this.rpc<boolean>("isDuplicate", messageId);
  }
  pushOutbox(chatId: string, text: string, kind: "client" | "gerante", direction: "in" | "out" = "out") {
    return this.rpc<void>("pushOutbox", chatId, text, kind, direction);
  }
  outbox() {
    return this.rpc<import("./core.ts").OutboxMessage[]>("outbox");
  }
  deliver(chatId: string, text: string) {
    return this.pushOutbox(chatId, text, "client", "out");
  }
  rateOk(chatId: string) {
    return this.rpc<boolean>("rateOk", chatId);
  }
  async quote(zone: string, items: { product_id: string; quantity: number }[]) {
    const products = await this.products();
    let subtotal = 0;
    let weight = 0;
    for (const it of items) {
      const p = products.find((x) => x.id === it.product_id);
      if (!p) throw new Error(`Article inconnu : ${it.product_id}`);
      subtotal += p.price_xof * it.quantity;
      weight += p.unit_weight_kg * it.quantity;
    }
    const q = quoteDelivery(zone, subtotal, weight);
    return { ...q, subtotal_xof: subtotal, total_xof: subtotal + q.fee_xof, weight_kg: Math.round(weight * 100) / 100 };
  }
  zones() {
    return zoneList;
  }
}
