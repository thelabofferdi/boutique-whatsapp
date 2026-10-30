import { PRODUCTS } from "../data/seed.ts";
import type { ChatMessage, Order, OrderStatus, Product } from "../types.ts";
import { quoteDelivery } from "./delivery.ts";

export type OutboxMessage = {
  id: string;
  chat_id: string;
  text: string;
  at: string;
  kind: "client" | "gerante";
  direction: "in" | "out";
};

export type ShopState = {
  version: number;
  products: Product[];
  orders: Record<string, Order>;
  order_codes: Record<string, string>;
  processed_messages: Record<string, string>;
  conversations: Record<string, ChatMessage[]>;
  last_customer_text: Record<string, string>;
  rate_limits: Record<string, number[]>;
  outbox: OutboxMessage[];
};

export type StateStore = {
  load(): Promise<ShopState | null>;
  save(state: ShopState): Promise<void>;
};

export function emptyState(): ShopState {
  return {
    version: 1,
    products: structuredClone(PRODUCTS),
    orders: {},
    order_codes: {},
    processed_messages: {},
    conversations: {},
    last_customer_text: {},
    rate_limits: {},
    outbox: [],
  };
}

const AFFIRMATIVE =
  /(^|[\s,.;!])(oui|ouais|ok|okay|d'accord|daccord|je confirme|confirme|je valide|valide|c'est bon|cest bon|parfait|vas(-| )y|envoie|envoye|go|yes|yep|ja)([\s,.;!]|$)/i;
const NEGATIVE = /(^|[\s,.;!])(non|no|nope|pas d'accord|annule|annuler|laisse|laisse tomber)([\s,.;!]|$)/i;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function shortCode(): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

function roundXof(n: number): number {
  return Math.round(n);
}

export class ShopCore {
  state: ShopState;
  private store: StateStore;
  private now: () => Date;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: StateStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
    this.state = emptyState();
  }

  async init(): Promise<this> {
    const loaded = await this.store.load();
    this.state = loaded ?? emptyState();
    // Migration douce : si le catalogue a évolué, on garde les prix/stock existants.
    for (const p of PRODUCTS) {
      if (!this.state.products.some((x) => x.id === p.id)) this.state.products.push({ ...p });
    }
    this.expireDrafts();
    return this;
  }

  private async persist(): Promise<void> {
    this.expireDrafts();
    await this.store.save(this.state);
  }

  /** Écriture différée : le webhook répond tout de suite, la sauvegarde attend la fin du tour. */
  private persistSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist();
    }, 10);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persist();
  }

  // ---------------------------------------------------------------- catalogue

  products(): Product[] {
    return this.state.products;
  }

  product(id: string): Product | undefined {
    return this.state.products.find((p) => p.id.toLowerCase() === id.toLowerCase());
  }

  search(query: string, opts: { category?: string; max_price_xof?: number } = {}): Product[] {
    const q = query.trim().toLowerCase();
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    let list = this.state.products;
    if (opts.category) list = list.filter((p) => p.category === opts.category);
    if (opts.max_price_xof) list = list.filter((p) => p.price_xof <= opts.max_price_xof!);
    if (!q || q === "*") return list;
    const scored = list
      .map((p) => {
        const hay = `${p.name} ${p.category} ${p.description} ${p.tags.join(" ")} ${p.colors.join(" ")}`.toLowerCase();
        let score = hay.includes(q) ? 5 : 0;
        for (const w of words) if (hay.includes(w)) score += 2;
        if (p.name.toLowerCase().includes(q)) score += 4;
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((x) => x.p);
  }

  // ------------------------------------------------------------------- stock

  /** Quantité déjà réservée par des commandes en cours (brouillon ou attente gérante). */
  reserved(productId: string): number {
    const now = this.now().getTime();
    let n = 0;
    for (const o of Object.values(this.state.orders)) {
      const active = o.status === "brouillon" || o.status === "attente_gerante";
      if (!active) continue;
      if (new Date(o.reserved_until).getTime() < now && o.status === "brouillon") continue;
      for (const l of o.lines) if (l.product_id === productId) n += l.quantity;
    }
    return n;
  }

  available(productId: string): number {
    const p = this.product(productId);
    return p ? Math.max(0, p.stock - this.reserved(p.id)) : 0;
  }

  stockInfo(productId: string) {
    const p = this.product(productId);
    if (!p) return null;
    return {
      product_id: p.id,
      name: p.name,
      category: p.category,
      colors: p.colors,
      stock: p.stock,
      reserved: this.reserved(p.id),
      available: this.available(p.id),
      unit_price_xof: p.price_xof,
      in_stock: this.available(p.id) > 0,
    };
  }

  // ---------------------------------------------------------------- commandes

  createDraft(input: {
    chatId: string;
    customerName: string;
    customerPhone: string;
    zone: string;
    items: { product_id: string; quantity: number; variant?: string }[];
    currency?: string;
    rate?: number;
  }): Order {
    this.expireDrafts();
    if (!input.items.length) throw new Error("La commande doit contenir au moins un article.");
    const lines = input.items.map((it) => {
      const p = this.product(it.product_id);
      if (!p) throw new Error(`Article inconnu : ${it.product_id}.`);
      const qty = Math.floor(Number(it.quantity));
      if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Quantité invalide pour ${p.name}.`);
      const avail = this.available(p.id);
      if (qty > avail) {
        throw new Error(
          avail <= 0
            ? `${p.name} est en rupture de stock.`
            : `Seulement ${avail} ${p.name} disponible(s) (${qty} demandé(s)).`,
        );
      }
      const variant = typeof it.variant === "string" ? it.variant.trim().slice(0, 40) : "";
      return {
        product_id: p.id,
        name: p.name,
        quantity: qty,
        unit_price_xof: p.price_xof,
        line_total_xof: p.price_xof * qty,
        ...(variant ? { variant } : {}),
        _weight: p.unit_weight_kg * qty,
      };
    });
    const subtotal = roundXof(lines.reduce((s, l) => s + l.line_total_xof, 0));
    const weight = lines.reduce((s, l) => s + l._weight, 0);
    const delivery = quoteDelivery(input.zone, subtotal, weight);
    const total = subtotal + delivery.fee_xof;
    const now = this.now();
    const id = `CMD-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${shortCode()}`;
    let code = shortCode();
    while (this.state.order_codes[code]) code = shortCode();
    const currency = (input.currency || "XOF").toUpperCase();
    const rate = input.rate ?? (currency === "XOF" ? 1 : null);
    const order: Order = {
      id,
      code,
      chat_id: input.chatId,
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      zone: delivery.zone,
      lines: lines.map(({ _weight, ...l }) => l),
      subtotal_xof: subtotal,
      delivery_xof: delivery.fee_xof,
      total_xof: total,
      currency,
      total_converted: rate ? Math.round(total * rate * 100) / 100 : null,
      rate_used: rate,
      status: "brouillon",
      created_at: now.toISOString(),
      reserved_until: new Date(now.getTime() + 30 * 60_000).toISOString(),
      history: [{ at: now.toISOString(), event: "devis créé (réservé 30 min)", by: "agent" }],
    };
    this.state.orders[id] = order;
    this.state.order_codes[code] = id;
    this.persistSoon();
    return order;
  }

  /** Le client doit avoir dit explicitement oui dans SON dernier message. */
  customerConfirm(orderIdOrCode: string, customerText: string): Order {
    const order = this.requireOrder(orderIdOrCode);
    if (order.status !== "brouillon") {
      throw new Error(`Cette commande est déjà « ${order.status} » : aucun nouveau devis à confirmer.`);
    }
    if (new Date(order.reserved_until).getTime() < this.now().getTime()) {
      order.status = "expiree";
      this.persistSoon();
      throw new Error("La réservation a expiré (30 min). Il faut refaire un devis.");
    }
    if (!this.isAffirmative(customerText)) {
      throw new Error(
        "Le client n'a pas encore dit clairement oui. Pose-lui la question et attends sa réponse avant de confirmer.",
      );
    }
    order.status = "attente_gerante";
    order.history.push({ at: this.now().toISOString(), event: "client a confirmé, attente gérante", by: "client" });
    this.persistSoon();
    return order;
  }

  /** Seule la gérante peut valider/refuser. Le canal vérifie son numéro avant d'appeler. */
  managerDecision(orderIdOrCode: string, decision: "confirmer" | "refuser", by: string, note = ""): Order {
    const order = this.requireOrder(orderIdOrCode);
    if (order.status === "confirmee" || order.status === "refusee") {
      return order; // idempotent : un double « OUI » ne décrémente pas deux fois
    }
    if (order.status !== "attente_gerante") {
      throw new Error(`La commande ${order.code} est « ${order.status} », elle n'attend pas la gérante.`);
    }
    if (decision === "confirmer") {
      for (const line of order.lines) {
        const p = this.product(line.product_id);
        if (!p) continue;
        if (p.stock < line.quantity) {
          throw new Error(`Stock insuffisant pour ${p.name} : ${p.stock} restant(s).`);
        }
        p.stock -= line.quantity;
      }
      order.status = "confirmee";
      order.confirmed_at = this.now().toISOString();
    } else {
      order.status = "refusee";
    }
    order.manager_note = note;
    order.history.push({
      at: this.now().toISOString(),
      event: decision === "confirmer" ? "validée par la gérante, stock décrémenté" : "refusée par la gérante",
      by,
    });
    this.persistSoon();
    return order;
  }

  getOrder(idOrCode: string): Order | undefined {
    const key = idOrCode.trim().toUpperCase();
    const id = this.state.order_codes[key] ?? key;
    return this.state.orders[id];
  }

  requireOrder(idOrCode: string): Order {
    const o = this.getOrder(idOrCode);
    if (!o) throw new Error(`Commande introuvable : ${idOrCode}.`);
    return o;
  }

  listOrders(): Order[] {
    return Object.values(this.state.orders).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  expireDrafts(): number {
    const now = this.now().getTime();
    let n = 0;
    for (const o of Object.values(this.state.orders)) {
      if (o.status === "brouillon" && new Date(o.reserved_until).getTime() < now) {
        o.status = "expiree";
        o.history.push({ at: new Date(now).toISOString(), event: "réservation expirée", by: "system" });
        n++;
      }
    }
    return n;
  }

  isAffirmative(text: string): boolean {
    return AFFIRMATIVE.test(text.normalize("NFC")) && !NEGATIVE.test(text.normalize("NFC"));
  }

  // ------------------------------------------------------------- messagerie

  /** Anti-doublon : Green API peut réémettre le même webhook. */
  isDuplicate(messageId: string): boolean {
    if (!messageId) return false;
    if (this.state.processed_messages[messageId]) return true;
    this.state.processed_messages[messageId] = this.now().toISOString();
    const cutoff = this.now().getTime() - 3 * 24 * 3600_000;
    for (const [k, v] of Object.entries(this.state.processed_messages)) {
      if (new Date(v).getTime() < cutoff) delete this.state.processed_messages[k];
    }
    this.persistSoon();
    return false;
  }

  conversation(chatId: string): ChatMessage[] {
    return this.state.conversations[chatId] ?? [];
  }

  appendConversation(chatId: string, messages: ChatMessage[], max = 24): void {
    const all = [...(this.state.conversations[chatId] ?? []), ...messages];
    // Garde les N derniers messages, sans couper une paire tool_call / tool.
    const trimmed = all.slice(-max);
    this.state.conversations[chatId] = trimmed;
    this.persistSoon();
  }

  setLastCustomerText(chatId: string, text: string): void {
    this.state.last_customer_text[chatId] = text;
    this.persistSoon();
  }

  lastCustomerText(chatId: string): string {
    return this.state.last_customer_text[chatId] ?? "";
  }

  /** Garde-fou anti-flood : 15 messages max par 5 minutes et par conversation. */
  rateOk(chatId: string, limit = 15, windowMs = 5 * 60_000): boolean {
    const now = this.now().getTime();
    const recent = (this.state.rate_limits[chatId] ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.state.rate_limits[chatId] = recent;
      this.persistSoon();
      return false;
    }
    recent.push(now);
    this.state.rate_limits[chatId] = recent;
    this.persistSoon();
    return true;
  }

  /** File d'envoi simulée : sert à l'interface de démo et aux captures d'écran. */
  pushOutbox(chatId: string, text: string, kind: "client" | "gerante", direction: "in" | "out" = "out"): OutboxMessage {
    const msg: OutboxMessage = {
      id: `OUT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      chat_id: chatId,
      text,
      at: this.now().toISOString(),
      kind,
      direction,
    };
    this.state.outbox.push(msg);
    if (this.state.outbox.length > 200) this.state.outbox = this.state.outbox.slice(-200);
    this.persistSoon();
    return msg;
  }

  outbox(): OutboxMessage[] {
    return this.state.outbox;
  }

  async reset(): Promise<void> {
    this.state = emptyState();
    await this.flush();
  }
}
