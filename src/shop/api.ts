import type { Product } from "../types.ts";
import { PRODUCTS } from "../data/seed.ts";
import { quoteDelivery, zoneList } from "./delivery.ts";
import type { ShopCore } from "./core.ts";

/**
 * API boutique utilisée par les agents.
 * - LocalShopApi : CLI, tests, banc de comparaison (fichier JSON).
 * - RemoteShopApi : Worker (Durable Object, état sérialisé et atomique).
 */
export type ShopApi = {
  products(): Promise<Product[]>;
  searchProducts(query: string, opts?: { category?: string; max_price_xof?: number }): Promise<Product[]>;
  stock(productId: string): Promise<ReturnType<ShopCore["stockInfo"]>>;
  createDraft(input: Parameters<ShopCore["createDraft"]>[0]): Promise<Awaited<ReturnType<ShopCore["createDraft"]>>>;
  customerConfirm(orderId: string, customerText: string): Promise<ReturnType<ShopCore["customerConfirm"]>>;
  getOrder(orderId: string): Promise<ReturnType<ShopCore["getOrder"]> | null>;
  listOrders(): Promise<ReturnType<ShopCore["listOrders"]>>;
  managerDecision(orderId: string, decision: "confirmer" | "refuser", by: string, note?: string): Promise<ReturnType<ShopCore["managerDecision"]>>;
  lastCustomerText(chatId: string): Promise<string>;
  setLastCustomerText(chatId: string, text: string): Promise<void>;
  conversation(chatId: string): Promise<import("../types.ts").ChatMessage[]>;
  appendConversation(chatId: string, messages: import("../types.ts").ChatMessage[]): Promise<void>;
  isDuplicate(messageId: string): Promise<boolean>;
  pushOutbox(chatId: string, text: string, kind: "client" | "gerante", direction?: "in" | "out"): Promise<void>;
  deliver(chatId: string, text: string): Promise<void>;
  rateOk(chatId: string): Promise<boolean>;
  quote(zone: string, items: { product_id: string; quantity: number }[]): Promise<ReturnType<typeof quoteDelivery> & { subtotal_xof: number; total_xof: number; weight_kg: number }>;
  zones(): typeof zoneList;
};

export const findProduct = (products: Product[], id: string): Product | undefined =>
  products.find((p) => p.id.toLowerCase() === id.toLowerCase());

export class LocalShopApi implements ShopApi {
  core: ShopCore;
  deliverFn: (chatId: string, text: string) => Promise<void>;

  constructor(core: ShopCore, deliverFn?: (chatId: string, text: string) => Promise<void>) {
    this.core = core;
    this.deliverFn = deliverFn ?? (async () => {});
  }

  async products() {
    return this.core.products();
  }
  async searchProducts(query: string, opts: { category?: string; max_price_xof?: number } = {}) {
    return this.core.search(query, opts);
  }
  async stock(productId: string) {
    return this.core.stockInfo(productId);
  }
  async createDraft(input: Parameters<ShopCore["createDraft"]>[0]) {
    return this.core.createDraft(input);
  }
  async customerConfirm(orderId: string, text: string) {
    return this.core.customerConfirm(orderId, text);
  }
  async getOrder(orderId: string) {
    return this.core.getOrder(orderId) ?? null;
  }
  async listOrders() {
    return this.core.listOrders();
  }
  async managerDecision(orderId: string, decision: "confirmer" | "refuser", by: string, note = "") {
    return this.core.managerDecision(orderId, decision, by, note);
  }
  async lastCustomerText(chatId: string) {
    return this.core.lastCustomerText(chatId);
  }
  async setLastCustomerText(chatId: string, text: string) {
    this.core.setLastCustomerText(chatId, text);
  }
  async conversation(chatId: string) {
    return this.core.conversation(chatId);
  }
  async appendConversation(chatId: string, messages: import("../types.ts").ChatMessage[]) {
    this.core.appendConversation(chatId, messages);
  }
  async isDuplicate(messageId: string) {
    return this.core.isDuplicate(messageId);
  }
  async pushOutbox(chatId: string, text: string, kind: "client" | "gerante", direction: "in" | "out" = "out") {
    this.core.pushOutbox(chatId, text, kind, direction);
  }
  async deliver(chatId: string, text: string) {
    await this.deliverFn(chatId, text);
  }
  async rateOk(chatId: string) {
    return this.core.rateOk(chatId);
  }
  async quote(zone: string, items: { product_id: string; quantity: number }[]) {
    let subtotal = 0;
    let weight = 0;
    for (const it of items) {
      const p = findProduct(this.core.products(), it.product_id);
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

export { PRODUCTS };
