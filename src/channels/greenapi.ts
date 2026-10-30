import type { AppConfig } from "../config.ts";
import { greenApiConfigured } from "../config.ts";

/**
 * Adaptateur Green API (WhatsApp non officiel, numéro de test).
 * Le webhook répond 200 tout de suite ; le traitement se fait dans waitUntil côté Worker.
 */

export type IncomingMessage = {
  id: string;
  chatId: string;
  phone: string;
  name: string;
  text: string;
  isGroup: boolean;
  fromManager: boolean;
  rawType: string;
};

export function parseGreenApi(payload: any, cfg: AppConfig): IncomingMessage | null {
  if (!payload || typeof payload !== "object") return null;
  if (payload.typeWebhook !== "incomingMessageReceived") return null;
  const sender = payload.senderData ?? {};
  const chatId = String(sender.chatId ?? "");
  if (!chatId) return null;
  const data = payload.messageData ?? {};
  let text = "";
  const type = String(data.typeMessage ?? "");
  if (type === "textMessage") text = data.textMessageData?.textMessage ?? "";
  else if (type === "extendedTextMessage") text = data.extendedTextMessageData?.text ?? "";
  else if (type === "quotedMessage") text = data.quotedMessage?.textMessage ?? "";
  else if (type === "buttonsResponseMessage") text = data.buttonsResponseMessage?.selectedButtonId ?? "";
  else if (type === "listResponseMessage") text = data.listResponseMessage?.title ?? "";
  text = String(text || "").trim();
  if (!text) return null;

  const phone = String(sender.sender ?? chatId).replace(/@.*$/, "").replace(/\D/g, "");
  const managerPhone = cfg.managerPhone.replace(/\D/g, "");
  return {
    id: String(payload.idMessage ?? ""),
    chatId,
    phone,
    name: String(sender.senderName || sender.chatName || phone),
    text,
    isGroup: chatId.endsWith("@g.us"),
    fromManager: phone === managerPhone || chatId === cfg.managerChatId,
    rawType: type,
  };
}

export async function sendGreenApi(cfg: AppConfig, chatId: string, text: string): Promise<void> {
  if (!greenApiConfigured(cfg)) throw new Error("Green API non configurée (GREENAPI_ID_INSTANCE / GREENAPI_TOKEN).");
  const url = `${cfg.greenApi.baseUrl}/waInstance${cfg.greenApi.idInstance}/sendMessage/${cfg.greenApi.token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId, message: text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Green API sendMessage ${res.status}: ${body.slice(0, 200)}`);
  }
}

export async function setTyping(cfg: AppConfig, chatId: string, seconds = 3): Promise<void> {
  if (!greenApiConfigured(cfg)) return;
  const url = `${cfg.greenApi.baseUrl}/waInstance${cfg.greenApi.idInstance}/typing/${cfg.greenApi.token}`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId, typing: true, seconds }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

/** Vérifie le secret partagé dans l'URL du webhook (Green API n'envoie pas de signature). */
export function webhookAuthorized(req: Request, url: URL, cfg: AppConfig): boolean {
  if (!cfg.webhookSecret) return true;
  const token = url.searchParams.get("token") || req.headers.get("x-webhook-secret");
  return token === cfg.webhookSecret;
}
