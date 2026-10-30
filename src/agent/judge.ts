import type { LlmClient } from "../llm.ts";
import type { Trace } from "../types.ts";
import { judgeSystem } from "../agent/prompts.ts";

export type JudgeResult = {
  exactitude: number;
  securite: number;
  clarte: number;
  ton: number;
  score: number;
  probleme: string;
  commentaire: string;
  tokens: number;
  cost_xof: number;
};

const clamp = (n: unknown) => Math.max(0, Math.min(4, Number(n) || 0));

function parseJudgeJson(text: string): any | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && ("score" in obj || "exactitude" in obj)) return obj;
    } catch {
      /* essaie le candidat suivant */
    }
  }
  return null;
}

/**
 * Juge LLM indépendant : note la réponse à partir des faits réellement renvoyés par les outils.
 * Deux tentatives avec des faits de plus en plus compacts (les longues conversations peuvent
 * produire une réponse vide ou coupée).
 */
export async function judgeTurn(opts: {
  llm: LlmClient;
  scenario: string;
  checkpoints: string[];
  conversation: { role: "client" | "agent"; text: string }[];
  trace: Trace;
}): Promise<JudgeResult> {
  const transcript = opts.conversation.map((m) => `${m.role === "client" ? "CLIENT" : "AGENT"} : ${m.text}`).join("\n\n");
  const allFacts = opts.trace.steps
    .filter((s) => s.kind === "tool")
    .map((s) => `${s.name}(${JSON.stringify(s.input).slice(0, 220)}) → ${JSON.stringify(s.output).slice(0, 700)}`)
    .join("\n");

  let usage = { input_tokens: 0, output_tokens: 0 };
  let lastRaw = "";
  for (const attempt of [0, 1]) {
    const facts = attempt === 0 ? allFacts.slice(0, 8000) : allFacts.slice(0, 2500);
    const res = await opts.llm.chat({
      messages: [
        { role: "system", content: judgeSystem() },
        {
          role: "user",
          content: `Scénario : ${opts.scenario}
Points de contrôle attendus :
${opts.checkpoints.map((c) => `- ${c}`).join("\n")}

Faits vérifiés par les outils :
${facts || "(aucun outil appelé)"}

Conversation :
${transcript.slice(0, 6000)}

Réponds uniquement en JSON, en une seule ligne, avec les 7 clés demandées.`,
        },
      ],
      json: true,
      temperature: 0,
      maxTokens: 1600,
    });
    usage = { input_tokens: usage.input_tokens + res.usage.input_tokens, output_tokens: usage.output_tokens + res.usage.output_tokens };
    lastRaw = res.text;
    const parsed = parseJudgeJson(res.text);
    if (parsed && typeof parsed.score !== "undefined") {
      const cost = opts.llm.cost(usage);
      return {
        exactitude: clamp(parsed.exactitude),
        securite: clamp(parsed.securite),
        clarte: clamp(parsed.clarte),
        ton: clamp(parsed.ton),
        score: clamp(parsed.score),
        probleme: String(parsed.probleme ?? ""),
        commentaire: String(parsed.commentaire ?? ""),
        tokens: usage.input_tokens + usage.output_tokens,
        cost_xof: cost.xof,
      };
    }
  }

  throw new Error(`juge illisible après 2 tentatives (${lastRaw.slice(0, 120)})`);
}
