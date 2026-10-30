import type { Order, Product, TraceStep } from "../types.ts";
import type { LlmClient } from "../llm.ts";

/**
 * Garde-fous déterministes (pas seulement des consignes dans le prompt) :
 * - aucun montant inventé dans la réponse client ;
 * - total = articles + livraison, recalculé depuis le catalogue ;
 * - format WhatsApp ;
 * - détection des tentatives de manipulation.
 */

const AMOUNT_RE = /(\d[\d\s\u00a0.,]*)\s*(FCFA|XOF|€|EUR|USD|\$|euros?)/gi;

export function extractAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const raw = m[1].trim().replace(/[\s\u00a0]/g, "");
    let normalized = raw;
    // 35.000 / 35,000 → 35000 ; 12,5 → 12.5 ; 12.50 → 12.5
    if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) normalized = raw.replace(/[.,]/g, "");
    else normalized = raw.replace(",", ".");
    const n = Number(normalized);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function collectAmounts(steps: TraceStep[]): number[] {
  const nums = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) nums.add(v);
    else if (typeof v === "string") for (const n of extractAmounts(v)) nums.add(n);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const s of steps) {
    if (s.kind === "tool") walk(s.output);
    if (s.kind === "llm") walk(s.output);
  }
  return [...nums];
}

export function ungroundedAmounts(reply: string, allowed: number[]): number[] {
  const set = new Set(allowed);
  return extractAmounts(reply).filter((n) => {
    if (set.has(n)) return false;
    // tolérance d'arrondi (conversion, centimes)
    for (const a of allowed) if (Math.abs(a - n) <= 1) return false;
    return true;
  });
}

/** Réécrit une seule fois la réponse si un montant n'est adossé à aucun outil. */
export async function enforceGroundedNumbers(
  reply: string,
  allowed: number[],
  llm: LlmClient,
  trace?: (step: TraceStep) => void,
): Promise<{ reply: string; violations: number[]; rewritten: boolean }> {
  const violations = ungroundedAmounts(reply, allowed);
  if (!violations.length) return { reply, violations, rewritten: false };

  const allowedList = [...new Set(allowed)].filter((n) => n > 0).sort((a, b) => a - b).slice(0, 40);
  const started = Date.now();
  try {
    const res = await llm.chat({
      messages: [
        {
          role: "system",
          content:
            "Tu corriges un message WhatsApp de boutique. Réécris-le en gardant le sens et le ton, mais en supprimant ou remplaçant TOUT montant absent de la liste autorisée. N'ajoute aucun chiffre. Si un prix est nécessaire et absent, dis que tu vérifies. Réponds uniquement avec le message final.",
        },
        {
          role: "user",
          content: `Montants autorisés (FCFA ou convertis) : ${allowedList.join(", ")}\nMontants fautifs : ${violations.join(", ")}\n\nMessage à corriger :\n${reply}`,
        },
      ],
      temperature: 0,
      maxTokens: 500,
    });
    trace?.({
      n: 0,
      at: new Date().toISOString(),
      ms: Date.now() - started,
      kind: "llm",
      name: "garde-fou_montants",
      input: { violations },
      output: res.text,
      tokens_in: res.usage.input_tokens,
      tokens_out: res.usage.output_tokens,
    });
    const stillBad = ungroundedAmounts(res.text, allowed);
    if (res.text && !stillBad.length) return { reply: res.text, violations, rewritten: true };
  } catch {
    // on tombe sur le repli sûr ci-dessous
  }
  return {
    reply:
      "Je vérifie le prix exact avec la gérante pour ne pas te donner un mauvais montant 🙏 Je reviens vers toi tout de suite avec le bon total.",
    violations,
    rewritten: true,
  };
}

export function checkOrderMath(order: Order, products: Product[]): { ok: boolean; detail: string } {
  const byId = new Map(products.map((p) => [p.id, p]));
  let subtotal = 0;
  for (const line of order.lines) {
    const p = byId.get(line.product_id);
    if (!p) return { ok: false, detail: `Article inconnu dans la commande : ${line.product_id}` };
    if (line.unit_price_xof !== p.price_xof)
      return { ok: false, detail: `Prix unitaire ${line.unit_price_xof} ≠ catalogue ${p.price_xof} pour ${p.name}` };
    if (line.line_total_xof !== line.unit_price_xof * line.quantity)
      return { ok: false, detail: `Ligne ${line.name} : total ligne incohérent` };
    subtotal += line.line_total_xof;
  }
  if (subtotal !== order.subtotal_xof) return { ok: false, detail: `Sous-total ${order.subtotal_xof} ≠ ${subtotal}` };
  if (order.subtotal_xof + order.delivery_xof !== order.total_xof)
    return { ok: false, detail: `Total ${order.total_xof} ≠ articles ${order.subtotal_xof} + livraison ${order.delivery_xof}` };
  return { ok: true, detail: `${order.subtotal_xof} + ${order.delivery_xof} = ${order.total_xof} FCFA` };
}

const INJECTION_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "prompt_injection", re: /ignore[rz]?\s+(tes|les|toutes?)\s+(instructions|r[eè]gles)/i },
  { kind: "prompt_injection", re: /(system prompt|affiche|montre|r[eé]v[eè]le)[^.]{0,30}(prompt|instructions)/i },
  { kind: "prompt_injection", re: /(tu es maintenant|from now on|jailbreak|\bDAN\b)/i },
  { kind: "fausse_gerante", re: /je suis (la |une )?g[eé]rante|la g[eé]rante (a dit|m'a dit|te demande)|maman adjovi (a dit|dit)/i },
  { kind: "remise_non_autorisee", re: /(remise|r[eé]duction|prix d'ami|dernier prix|gratuit)[^.]{0,40}(%|pour cent|sinon)/i },
  { kind: "extraction_secret", re: /(cl[eé] api|api key|token|mot de passe|identifiants?)/i },
  { kind: "validation_forcée", re: /(valide|confirme)[^.]{0,30}(sans|avant)[^.]{0,20}(g[eé]rante|accord)/i },
];

export function scanInjection(text: string): { kind: string; detail: string }[] {
  const hits: { kind: string; detail: string }[] = [];
  for (const p of INJECTION_PATTERNS) {
    const m = text.match(p.re);
    if (m) hits.push({ kind: p.kind, detail: m[0].slice(0, 120) });
  }
  return hits;
}

/** Corrige mécaniquement le Markdown que le modèle produit parfois (WhatsApp n'utilise que *simple*). */
export function normalizeWhatsApp(reply: string): string {
  let out = reply
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
  return out.trim();
}

export function checkWhatsAppFormat(reply: string): { ok: boolean; detail: string } {
  const issues: string[] = [];
  if (reply.length > 1200) issues.push(`trop long (${reply.length} caractères)`);
  if (/\*\*[^*]+\*\*/.test(reply)) issues.push("gras Markdown ** interdit sur WhatsApp");
  if (/^#{1,6}\s/m.test(reply)) issues.push("titres Markdown interdits");
  if (/```/.test(reply)) issues.push("bloc de code interdit");
  if (!reply.trim()) issues.push("réponse vide");
  return { ok: issues.length === 0, detail: issues.length ? issues.join(" ; ") : "format WhatsApp respecté" };
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 6 ? `${digits.slice(0, 4)}•••${digits.slice(-2)}` : "•••";
}
