/** Formats lisibles pour WhatsApp (séparateurs de milliers à la française). */
export const fmtXof = (n: number): string => new Intl.NumberFormat("fr-FR").format(Math.round(n));
export const fmtMoney = (n: number, currency = "FCFA"): string =>
  currency === "FCFA" ? `${fmtXof(n)} FCFA` : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(n)} ${currency}`;
