import type { Conversion } from "../types.ts";

/**
 * Conversion FCFA → devise du client, via une vraie API de taux (aucun taux inventé).
 * Source principale : open.er-api.com (sans clé). Secours : currency-api (jsDelivr).
 * Cache mémoire 1 h pour éviter de marteler l'API à chaque message.
 */
const ALLOWED = new Set(["EUR", "USD", "GBP", "CAD", "CHF", "GHS", "NGN", "XOF"]);

type Rates = { rates: Record<string, number>; as_of: string; source: string };
const cache = new Map<string, { value: Rates; expires: number }>();
let lastFailure = 0;

export async function fetchRates(base = "XOF"): Promise<Rates> {
  const hit = cache.get(base);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (lastFailure && Date.now() - lastFailure < 120_000) {
    throw new Error("Taux momentanément indisponible (API en échec il y a moins de 2 min). Reste en FCFA.");
  }
  const errors: string[] = [];

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data?.result === "success" && data.rates) {
        const value = { rates: data.rates, as_of: data.time_last_update_utc || new Date().toISOString(), source: "open.er-api.com" };
        cache.set(base, { value, expires: Date.now() + 3600_000 });
        return value;
      }
      errors.push(`open.er-api: ${data?.result ?? res.status}`);
    } else errors.push(`open.er-api: HTTP ${res.status}`);
  } catch (err) {
    errors.push(`open.er-api: ${(err as Error).message}`);
  }

  try {
    const res = await fetch(
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base.toLowerCase()}.json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.ok) {
      const data = (await res.json()) as any;
      const table = data?.[base.toLowerCase()];
      if (table && Object.keys(table).length) {
        const rates: Record<string, number> = {};
        for (const [k, v] of Object.entries(table)) rates[k.toUpperCase()] = Number(v);
        const value = { rates, as_of: data.date || new Date().toISOString(), source: "currency-api (jsDelivr)" };
        cache.set(base, { value, expires: Date.now() + 3600_000 });
        return value;
      }
      errors.push("currency-api: réponse vide");
    } else errors.push(`currency-api: HTTP ${res.status}`);
  } catch (err) {
    errors.push(`currency-api: ${(err as Error).message}`);
  }

  lastFailure = Date.now();
  throw new Error(`Taux de change indisponible (${errors.join(" ; ")}). Reste en FCFA pour ce message.`);
}

export async function convertXof(amountXof: number, currency: string): Promise<Conversion> {
  const code = currency.trim().toUpperCase();
  if (!ALLOWED.has(code)) {
    throw new Error(`Devise non prise en charge : ${code}. Devises acceptées : ${[...ALLOWED].join(", ")}.`);
  }
  if (!Number.isFinite(amountXof) || amountXof <= 0) throw new Error("Montant en FCFA invalide.");
  if (code === "XOF") {
    return { amount_xof: amountXof, currency: "XOF", amount: amountXof, rate: 1, as_of: new Date().toISOString(), source: "parité" };
  }
  const { rates, as_of, source } = await fetchRates("XOF");
  const rate = rates[code];
  if (!rate || !Number.isFinite(rate)) throw new Error(`Pas de taux disponible pour ${code}.`);
  return {
    amount_xof: Math.round(amountXof),
    currency: code,
    amount: Math.round(amountXof * rate * 100) / 100,
    rate,
    as_of,
    source,
  };
}

export function clearRateCache(): void {
  cache.clear();
}
