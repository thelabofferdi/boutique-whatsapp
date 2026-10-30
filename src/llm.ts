import type { AppConfig } from "./config.ts";
import type { ChatMessage, ToolCall, Usage } from "./types.ts";

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  toolChoice?: "auto" | "none";
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  model?: string;
};

export type ChatResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  latencyMs: number;
  finishReason: string;
};

/**
 * Client minimal pour l'API RodiumAI (compatible OpenAI).
 * - 3 tentatives sur 429 / 5xx / réseau (le webhook WhatsApp doit être robuste).
 * - Comptage des tokens pour le tableau de comparaison coût / latence.
 */
export class LlmClient {
  private cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    if (!cfg.rodiumApiKey) throw new Error("RODIUM_API_KEY absente.");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model || this.cfg.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 900,
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? "auto";
    }
    if (req.json) body.response_format = { type: "json_object" };

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(`${this.cfg.rodiumBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.cfg.rodiumApiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`RodiumAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
          await sleep(700 * attempt * attempt);
          continue;
        }
        if (!res.ok) {
          throw new Error(`RodiumAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        const data = (await res.json()) as any;
        const choice = data.choices?.[0];
        const message = choice?.message ?? {};
        return {
          text: (message.content ?? "").trim(),
          toolCalls: (message.tool_calls ?? []) as ToolCall[],
          usage: {
            input_tokens: data.usage?.prompt_tokens ?? 0,
            output_tokens: data.usage?.completion_tokens ?? 0,
          },
          model: data.model ?? body.model,
          latencyMs: Date.now() - started,
          finishReason: String(choice?.finish_reason ?? "stop"),
        };
      } catch (err) {
        lastError = err;
        if (attempt === 3) break;
        await sleep(700 * attempt * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Coût en « RODI » puis en FCFA.
   * 1 RODI = 0,01 USD (tarifs /models de RodiumAI) et 1 USD ≈ 600 FCFA (parité fixe XOF).
   */
  cost(usage: Usage): { rodi: number; xof: number } {
    const rodi =
      (usage.input_tokens / 1_000_000) * this.cfg.priceInputPerM +
      (usage.output_tokens / 1_000_000) * this.cfg.priceOutputPerM;
    return { rodi, xof: rodi * 6 };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}
