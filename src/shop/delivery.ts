import { DELIVERY_ZONES } from "../data/seed.ts";
import type { DeliveryQuote } from "../types.ts";

/**
 * Frais de livraison : grille fixe, calculée en code (jamais par le LLM).
 * Le poids est celui des articles réellement commandés, pas une estimation du modèle.
 */
export function quoteDelivery(zoneId: string, subtotalXof: number, weightKg: number): DeliveryQuote {
  const zone = DELIVERY_ZONES.find((z) => z.id === zoneId);
  if (!zone) {
    throw new Error(
      `Zone inconnue « ${zoneId} ». Zones valides : ${DELIVERY_ZONES.map((z) => z.id).join(", ")}.`,
    );
  }
  const extraWeight = Math.max(0, Math.ceil(weightKg - zone.weight_included_kg));
  const base = zone.free_above_xof !== null && subtotalXof >= zone.free_above_xof ? 0 : zone.fee_xof;
  const fee = base + extraWeight * zone.per_extra_kg_xof;
  return {
    zone: zone.id,
    label: zone.label,
    fee_xof: fee,
    eta: zone.eta,
    free: fee === 0 && zone.fee_xof > 0,
    note:
      extraWeight > 0
        ? `${extraWeight} kg au-delà des ${zone.weight_included_kg} kg inclus (+${extraWeight * zone.per_extra_kg_xof} FCFA)`
        : undefined,
  };
}

export function zoneList(): { id: string; label: string; fee_xof: number; eta: string; free_above_xof: number | null }[] {
  return DELIVERY_ZONES.map((z) => ({
    id: z.id,
    label: z.label,
    fee_xof: z.fee_xof,
    eta: z.eta,
    free_above_xof: z.free_above_xof,
  }));
}
