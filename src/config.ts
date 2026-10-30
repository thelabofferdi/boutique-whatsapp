/**
 * Configuration : tout vient de l'environnement (Worker, CLI, tests).
 * Aucune clé n'est écrite dans le code.
 */

export type Env = Record<string, string | undefined>;

export type AppConfig = {
  rodiumApiKey: string;
  rodiumBaseUrl: string;
  model: string;
  shopName: string;
  shopCity: string;
  managerPhone: string;
  managerChatId: string;
  greenApi: { idInstance: string; token: string; baseUrl: string };
  webhookSecret: string;
  simulator: boolean;
  agentMode: "solo" | "equipe";
  timezone: string;
  // Tarifs RodiumAI en « RODI » pour 1 M de tokens (1 RODI = 0,01 USD, cf. API /models).
  priceInputPerM: number;
  priceOutputPerM: number;
};

export function loadConfig(env: Env = process.env): AppConfig {
  const managerPhone = env.MANAGER_PHONE || "22990000001";
  return {
    rodiumApiKey: env.RODIUM_API_KEY || "",
    rodiumBaseUrl: (env.RODIUM_BASE_URL || "https://api.rodiumai.io/v1").replace(/\/$/, ""),
    model: env.RODIUM_MODEL || "anthropic/claude-haiku-5-5",
    shopName: env.SHOP_NAME || "Chez Maman Adjovi",
    shopCity: env.SHOP_CITY || "Cotonou",
    managerPhone,
    managerChatId: env.MANAGER_CHAT_ID || `${managerPhone}@c.us`,
    greenApi: {
      idInstance: env.GREENAPI_ID_INSTANCE || "",
      token: env.GREENAPI_TOKEN || "",
      baseUrl: (env.GREENAPI_BASE_URL || "https://api.green-api.com").replace(/\/$/, ""),
    },
    webhookSecret: env.WEBHOOK_SECRET || "",
    simulator: env.SIMULATOR !== "0",
    agentMode: env.AGENT_MODE === "solo" ? "solo" : "equipe",
    timezone: env.TZ || "Africa/Porto-Novo",
    priceInputPerM: Number(env.PRICE_INPUT_PER_M || 75.7),
    priceOutputPerM: Number(env.PRICE_OUTPUT_PER_M || 378.3),
  };
}

export function requireLlmConfig(cfg: AppConfig): void {
  if (!cfg.rodiumApiKey) {
    throw new Error("RODIUM_API_KEY manquante : copie .env.example vers .env puis renseigne la clé.");
  }
}

export const greenApiConfigured = (cfg: AppConfig): boolean =>
  Boolean(cfg.greenApi.idInstance && cfg.greenApi.token);
