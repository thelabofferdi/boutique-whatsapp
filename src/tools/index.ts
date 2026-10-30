import type { AppConfig } from "../config.ts";
import type { ShopApi } from "../shop/api.ts";
import type { Order, Product } from "../types.ts";
import { convertXof } from "./currency.ts";
import { zoneList } from "../shop/delivery.ts";
import { fmtXof } from "../format.ts";

export type ToolCtx = {
  shop: ShopApi;
  cfg: AppConfig;
  chatId: string;
  customerName?: string;
  customerPhone?: string;
  /** Notifie la gérante sur WhatsApp (ou dans la console de démo). */
  notifyManager?: (text: string) => Promise<void>;
  /** Journalise une alerte de sécurité (tentative de manipulation, etc.). */
  onSecurity?: (kind: string, detail: string) => void;
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any, ctx: ToolCtx) => Promise<unknown>;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

/** Le modèle écrit parfois la chaîne "undefined" : on la traite comme absente. */
const clean = (v: unknown): string => {
  const s = String(v ?? "").trim();
  return /^(undefined|null|none|n\/a)$/i.test(s) ? "" : s;
};
const N = (description: string, extra: Record<string, unknown> = {}) => ({ type: "number", description, ...extra });

const itemSchema = {
  type: "array",
  description: "Articles demandés",
  items: obj(
    {
      product_id: S("Identifiant produit, ex. PAG-002"),
      quantity: N("Quantité (entier ≥ 1)"),
    },
    ["product_id", "quantity"],
  ),
};

function compactProduct(p: Product, available: number) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    price_xof: p.price_xof,
    available,
    colors: p.colors,
    description: p.description,
  };
}

export function orderSummary(o: Order, cfg: AppConfig) {
  return {
    order_id: o.id,
    code: o.code,
    status: o.status,
    customer: o.customer_name,
    phone: o.customer_phone,
    zone: o.zone,
    lines: o.lines.map((l) => ({ product_id: l.product_id, name: l.name, quantity: l.quantity, unit_price_xof: l.unit_price_xof, line_total_xof: l.line_total_xof })),
    subtotal_xof: o.subtotal_xof,
    delivery_xof: o.delivery_xof,
    total_xof: o.total_xof,
    currency: o.currency,
    total_converted: o.total_converted,
    rate_used: o.rate_used,
    reserved_until: o.reserved_until,
    shop: cfg.shopName,
  };
}

export const searchProducts: ToolDef = {
  name: "search_products",
  description:
    "Cherche des articles du catalogue (pagnes, bazin, accessoires, chaussures). Renvoie les prix RÉELS et la disponibilité. À appeler avant de citer un prix ou de proposer un article.",
  parameters: obj(
    {
      query: S("Mots-clés en français : type d'article, couleur, occasion (mariage, baptême), matière…"),
      category: S("Filtrer par catégorie", { enum: ["pagne", "bazin", "accessoire", "chaussure"] }),
      max_price_xof: N("Prix maximum en FCFA"),
    },
    ["query"],
  ),
  async execute(args, ctx) {
    const found = await ctx.shop.searchProducts(String(args.query ?? ""), {
      category: args.category,
      max_price_xof: args.max_price_xof,
    });
    const products = await ctx.shop.products();
    const avail = new Map<string, number>();
    for (const p of products) {
      const info = await ctx.shop.stock(p.id);
      avail.set(p.id, info?.available ?? 0);
    }
    return {
      count: found.length,
      results: found.slice(0, 8).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        price_xof: p.price_xof,
        colors: p.colors,
        description: p.description,
      })),
      stock_hint: "Le stock n'est pas dans ce résultat : appelle check_stock avant d'affirmer une disponibilité.",
      note: found.length === 0 ? "Aucun article ne correspond. Propose de préciser ou une autre catégorie." : undefined,
    };
  },
};

export const checkStock: ToolDef = {
  name: "check_stock",
  description:
    "Vérifie le stock réellement disponible (stock moins les réservations en cours) pour un article et une quantité. En cas de rupture, renvoie des alternatives disponibles.",
  parameters: obj({ product_id: S("Identifiant produit"), quantity: N("Quantité souhaitée", { minimum: 1 }) }, ["product_id"]),
  async execute(args, ctx) {
    const info = await ctx.shop.stock(String(args.product_id));
    if (!info) return { error: `Article inconnu : ${args.product_id}` };
    const qty = Math.max(1, Math.floor(Number(args.quantity ?? 1)));
    const product = (await ctx.shop.products()).find((p) => p.id === info.product_id)!;
    let alternatives: unknown[] = [];
    if (info.available < qty) {
      const others = (await ctx.shop.searchProducts("", { category: product.category }))
        .filter((p) => p.id !== product.id)
        .sort((a, b) => Math.abs(a.price_xof - product.price_xof) - Math.abs(b.price_xof - product.price_xof));
      for (const p of others) {
        const i = await ctx.shop.stock(p.id);
        if ((i?.available ?? 0) >= qty) alternatives.push({ id: p.id, name: p.name, price_xof: p.price_xof, available: i!.available });
        if (alternatives.length >= 2) break;
      }
    }
    return {
      ...info,
      requested: qty,
      enough: info.available >= qty,
      alternatives,
      message: info.available >= qty ? "Disponible." : info.available <= 0 ? "Rupture de stock." : `Stock insuffisant (${info.available} disponibles).`,
    };
  },
};

export const quoteDelivery: ToolDef = {
  name: "quote_delivery",
  description:
    "Calcule les frais de livraison et le total (articles + livraison) à partir des articles RÉELS. Utilise les identifiants de zone fournis. N'invente jamais de frais.",
  parameters: obj(
    {
      zone: S("Zone de livraison", { enum: zoneList().map((z) => z.id) }),
      items: itemSchema,
    },
    ["zone", "items"],
  ),
  async execute(args, ctx) {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) return { error: "Aucun article fourni." };
    const q = await ctx.shop.quote(String(args.zone), items);
    return {
      ...q,
      total_xof: q.total_xof,
      message: `Livraison ${q.label} : ${q.fee_xof} FCFA. Total articles + livraison : ${q.total_xof} FCFA.`,
    };
  },
};

export const convertCurrency: ToolDef = {
  name: "convert_currency",
  description:
    "Convertit un montant en FCFA vers la devise du client avec un taux de change réel (API publique, date et source renvoyées).",
  parameters: obj(
    {
      amount_xof: N("Montant en FCFA (XOF)"),
      currency: S("Devise cible", { enum: ["EUR", "USD", "GBP", "CAD", "CHF", "GHS", "NGN"] }),
    },
    ["amount_xof", "currency"],
  ),
  async execute(args) {
    return convertXof(Number(args.amount_xof), String(args.currency));
  },
};

export const prepareOrder: ToolDef = {
  name: "prepare_order",
  description:
    "Prépare un DEVIS (pas une commande ferme) : vérifie le stock, calcule le total en code, réserve les articles 30 minutes. À utiliser seulement quand tu as les articles, la quantité, le nom, le téléphone et la zone. Ensuite, demande au client de confirmer explicitement.",
  parameters: obj(
    {
      items: itemSchema,
      customer_name: S("Nom du client (optionnel : repris du profil WhatsApp)"),
      customer_phone: S("Numéro WhatsApp du client (optionnel : repris du profil)"),
      zone: S("Zone de livraison", { enum: zoneList().map((z) => z.id) }),
      currency: S("Devise d'affichage souhaitée par le client (défaut XOF)", { enum: ["XOF", "EUR", "USD", "GBP", "CAD", "CHF", "GHS", "NGN"] }),
    },
    ["items", "zone"],
  ),
  async execute(args, ctx) {
    const currency = String(args.currency ?? "XOF").toUpperCase();
    const items = (args.items as { product_id: string; quantity: number }[]).map((it) => ({
      product_id: String(it.product_id),
      quantity: Math.floor(Number(it.quantity)),
    }));
    let rate: number | undefined;
    if (currency !== "XOF") {
      const first = await ctx.shop.quote(String(args.zone), items);
      rate = (await convertXof(first.total_xof, currency)).rate;
    }
    const order = await ctx.shop.createDraft({
      chatId: ctx.chatId,
      customerName: clean(args.customer_name) || ctx.customerName || "Client WhatsApp",
      customerPhone: clean(args.customer_phone) || ctx.customerPhone || ctx.chatId.replace(/@.*$/, ""),
      zone: String(args.zone),
      items,
      currency,
      rate,
    });
    return {
      ...orderSummary(order, ctx.cfg),
      warning: "DEVIS, pas encore une commande. Résume-le au client et demande-lui de répondre OUI pour confirmer.",
      expires_in_minutes: 30,
    };
  },
};

export const confirmOrder: ToolDef = {
  name: "confirm_order",
  description:
    "Confirme la commande APRÈS un « oui » explicite du client dans son dernier message. Le serveur vérifie ce oui ; sinon la confirmation est refusée. La commande part ensuite à la validation de la gérante sur WhatsApp.",
  parameters: obj(
    {
      order_id: S("Identifiant ou code de la commande (ex. CMD-… ou A7K2)"),
      customer_consent: { type: "boolean", description: "true uniquement si le client vient de dire oui explicitement" },
    },
    ["order_id", "customer_consent"],
  ),
  async execute(args, ctx) {
    if (args.customer_consent !== true) {
      return { error: "Le client n'a pas donné son accord explicite. Demande-lui « Je confirme » avant de valider." };
    }
    const last = await ctx.shop.lastCustomerText(ctx.chatId);
    const order = await ctx.shop.customerConfirm(String(args.order_id), last);
    const managerText = [
      `🧾 *Nouvelle commande à valider*`,
      `Code : *${order.code}* (${order.id})`,
      `Client : ${order.customer_name} — ${order.customer_phone}`,
      ...order.lines.map((l) => `• ${l.quantity} × ${l.name} = ${fmtXof(l.line_total_xof)} FCFA`),
      `Sous-total : ${fmtXof(order.subtotal_xof)} FCFA`,
      `Livraison (${order.zone}) : ${fmtXof(order.delivery_xof)} FCFA`,
      `*TOTAL : ${fmtXof(order.total_xof)} FCFA*`,
      ``,
      `Réponds *OUI ${order.code}* pour valider ou *NON ${order.code}* pour refuser.`,
    ].join("\n");
    await ctx.notifyManager?.(managerText);
    return {
      ...orderSummary(order, ctx.cfg),
      message: "Commande transmise à la gérante. Le client doit être prévenu que la validation est en cours.",
    };
  },
};

export const orderStatus: ToolDef = {
  name: "order_status",
  description: "Donne le statut d'une commande (brouillon, attente gérante, confirmée, refusée, expirée) et son récapitulatif.",
  parameters: obj({ order_id: S("Identifiant ou code de la commande") }, ["order_id"]),
  async execute(args, ctx) {
    const order = await ctx.shop.getOrder(String(args.order_id));
    if (!order) return { error: `Commande introuvable : ${args.order_id}` };
    return orderSummary(order, ctx.cfg);
  },
};

export const DELIVERY_ZONES = zoneList;

export const SOLO_TOOLS: ToolDef[] = [searchProducts, checkStock, quoteDelivery, convertCurrency, prepareOrder, confirmOrder, orderStatus];

/** Outils de la gérante (jamais exposés au client). */
export const MANAGER_TOOLS: ToolDef[] = [orderStatus];
