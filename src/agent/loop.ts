import type { AppConfig } from "../config.ts";
import { LlmClient } from "../llm.ts";
import type { ShopApi } from "../shop/api.ts";
import type { Order, Trace, TraceStep, Usage, ChatMessage } from "../types.ts";
import { SOLO_TOOLS, type ToolCtx, type ToolDef } from "../tools/index.ts";
import { copywriterSystem, logisticianSystem, managerSystem, sellerSystem, soloSystem } from "./prompts.ts";
import {
  checkOrderMath,
  checkWhatsAppFormat,
  collectAmounts,
  enforceGroundedNumbers,
  normalizeWhatsApp,
  scanInjection,
  ungroundedAmounts,
} from "./guardrails.ts";

export type RootInput = {
  cfg: AppConfig;
  shop: ShopApi;
  llm?: LlmClient;
  chatId: string;
  userText: string;
  customerName?: string;
  customerPhone?: string;
  scenario?: string;
  notifyManager?: (text: string) => Promise<void>;
  maxSteps?: number;
  /** Devis/commande en cours pour ce client, injecté dans le prompt. */
  orderContext?: string;
};

export type RunResult = {
  reply: string;
  trace: Trace;
  orders: Order[];
};

type StepCollector = {
  steps: TraceStep[];
  usage: Usage;
};

let stepCounter = 0;

function record(
  c: StepCollector,
  step: Omit<TraceStep, "n" | "at"> & { at?: string },
): void {
  c.steps.push({ ...step, n: ++stepCounter, at: step.at ?? new Date().toISOString() } as TraceStep);
  if (step.tokens_in) c.usage.input_tokens += step.tokens_in;
  if (step.tokens_out) c.usage.output_tokens += step.tokens_out;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} : délai dépassé (${ms} ms)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toSchema(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

type LoopResult = { reply: string; messages: ChatMessage[]; forced: boolean };

/** Boucle ReAct générique : LLM → outils → LLM …, avec limite d'étapes et trace lisible. */
export async function runLoop(opts: {
  llm: LlmClient;
  system: string;
  tools: ToolDef[];
  ctx: ToolCtx;
  history: ChatMessage[];
  userText: string;
  maxSteps: number;
  collector: StepCollector;
  agentName: string;
  temperature?: number;
}): Promise<LoopResult> {
  if (!opts.userText.trim()) {
    return { reply: "", messages: [], forced: false };
  }
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    ...opts.history.slice(-12),
    { role: "user", content: opts.userText },
  ];
  const schemas = toSchema(opts.tools);

  for (let step = 1; step <= opts.maxSteps; step++) {
    const started = Date.now();
    const res = await opts.llm.chat({
      messages,
      tools: schemas,
      temperature: opts.temperature ?? 0.2,
      maxTokens: 900,
    });
    record(opts.collector, {
      ms: Date.now() - started,
      kind: "llm",
      name: opts.agentName,
      input: { step, messages: messages.length },
      output: res.text || "(appel d'outils)",
      tokens_in: res.usage.input_tokens,
      tokens_out: res.usage.output_tokens,
      agent: opts.agentName,
    });

    if (!res.toolCalls.length) {
      if (res.finishReason === "length") {
        // Réponse coupée par la limite de tokens : on demande une version courte et complète.
        const short = await opts.llm.chat({
          messages: [
            { role: "system", content: opts.system },
            ...opts.history.slice(-6),
            { role: "user", content: opts.userText },
            { role: "user", content: "Réponds au client en 450 caractères maximum : l'essentiel (articles, total, code si devis, prochaine étape). N'invente aucun chiffre, pas de liste interminable." },
          ],
          toolChoice: "none",
          maxTokens: 600,
          temperature: 0.2,
        });
        record(opts.collector, {
          ms: short.latencyMs,
          kind: "llm",
          name: `${opts.agentName} (réponse coupée, raccourcie)`,
          output: short.text,
          tokens_in: short.usage.input_tokens,
          tokens_out: short.usage.output_tokens,
          agent: opts.agentName,
        });
        messages.push({ role: "assistant", content: short.text });
        return { reply: short.text, messages, forced: false };
      }
      if (res.text.trim()) {
        messages.push({ role: "assistant", content: res.text });
        return { reply: res.text, messages, forced: false };
      }
      // Réponse vide : un seul rappel explicite, puis on laisse le garde-fou prendre le relais.
      const retry = await opts.llm.chat({
        messages: [...messages, { role: "user", content: "Ta réponse est vide. Réponds maintenant au client en une ou deux phrases utiles." }],
        toolChoice: "none",
        maxTokens: 300,
        temperature: 0.2,
      });
      record(opts.collector, {
        ms: retry.latencyMs,
        kind: "llm",
        name: `${opts.agentName} (relance réponse vide)`,
        output: retry.text,
        tokens_in: retry.usage.input_tokens,
        tokens_out: retry.usage.output_tokens,
        agent: opts.agentName,
      });
      messages.push({ role: "assistant", content: retry.text });
      return { reply: retry.text, messages, forced: false };
    }

    messages.push({ role: "assistant", content: res.text || null, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      const tool = opts.tools.find((t) => t.name === call.function.name);
      const t0 = Date.now();
      let output: unknown;
      if (!tool) {
        output = { error: `Outil inconnu : ${call.function.name}. Outils disponibles : ${opts.tools.map((t) => t.name).join(", ")}` };
      } else {
        let args: any = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          output = { error: "Arguments JSON invalides. Réessaie avec un objet JSON valide." };
        }
        if (!output) {
          try {
            output = await withTimeout(tool.execute(args, opts.ctx), 90_000, call.function.name);
          } catch (err) {
            output = { error: (err as Error).message };
          }
        }
      }
      record(opts.collector, {
        ms: Date.now() - t0,
        kind: "tool",
        name: call.function.name,
        input: call.function.arguments ? safeJson(call.function.arguments) : {},
        output: truncate(output),
        agent: opts.agentName,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(output).slice(0, 6000),
      });
    }
  }

  // Limite atteinte : on force une réponse honnête, sans nouvel outil.
  const started = Date.now();
  messages.push({
    role: "user",
    content:
      "Limite d'étapes atteinte. Réponds MAINTENANT au client avec les informations vérifiées. Si une info manque, dis que tu vérifies avec la gérante. N'invente aucun chiffre.",
  });
  const res = await opts.llm.chat({ messages, toolChoice: "none", maxTokens: 400, temperature: 0.2 });
  record(opts.collector, {
    ms: Date.now() - started,
    kind: "llm",
    name: `${opts.agentName} (repli limite d'étapes)`,
    output: res.text,
    tokens_in: res.usage.input_tokens,
    tokens_out: res.usage.output_tokens,
    agent: opts.agentName,
  });
  let text = res.text;
  if (!text.trim() || text.trim().length < 20) {
    const retry = await opts.llm.chat({
      messages: [
        { role: "system", content: opts.system },
        ...opts.history.slice(-6),
        { role: "user", content: opts.userText },
        { role: "user", content: "Résume en 3 lignes maximum, sans inventer de chiffre, ce que tu as vérifié et la prochaine étape pour le client." },
      ],
      maxTokens: 350,
      temperature: 0.2,
    });
    record(opts.collector, {
      ms: retry.latencyMs,
      kind: "llm",
      name: `${opts.agentName} (repli final)`,
      output: retry.text,
      tokens_in: retry.usage.input_tokens,
      tokens_out: retry.usage.output_tokens,
      agent: opts.agentName,
    });
    text = retry.text;
  }
  messages.push({ role: "assistant", content: text });
  return { reply: text, messages, forced: true };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s.slice(0, 500);
  }
}

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v);
  if (s.length <= 4000) return v;
  return { truncated: true, preview: s.slice(0, 4000) };
}

function buildTrace(input: {
  architecture: "solo" | "equipe";
  scenario?: string;
  startedAt: number;
  collector: StepCollector;
  reply: string;
  checks: Trace["checks"];
  cost: { rodi: number; xof: number };
}): Trace {
  return {
    id: crypto.randomUUID(),
    scenario: input.scenario,
    architecture: input.architecture,
    started_at: new Date(input.startedAt).toISOString(),
    duration_ms: Date.now() - input.startedAt,
    steps: input.collector.steps,
    tokens_in: input.collector.usage.input_tokens,
    tokens_out: input.collector.usage.output_tokens,
    cost_rodi: input.cost.rodi,
    cost_xof: input.cost.xof,
    reply: input.reply,
    checks: input.checks,
  };
}

function baseCtx(input: RootInput, cfg: AppConfig): ToolCtx {
  return {
    shop: input.shop,
    cfg,
    chatId: input.chatId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    notifyManager: input.notifyManager,
    onSecurity: (kind, detail) => {
      recordSecurity(input, kind, detail);
    },
  };
}

const securityLog = new Map<string, { kind: string; detail: string }[]>();
function recordSecurity(input: RootInput, kind: string, detail: string) {
  const key = `${input.chatId}:${input.userText}`;
  const arr = securityLog.get(key) ?? [];
  arr.push({ kind, detail });
  securityLog.set(key, arr);
}
export function securityHits(input: RootInput): { kind: string; detail: string }[] {
  return scanInjection(input.userText).concat(securityLog.get(`${input.chatId}:${input.userText}`) ?? []);
}

function checksFor(opts: {
  input: RootInput;
  reply: string;
  steps: TraceStep[];
  orders: Order[];
  products: Awaited<ReturnType<ShopApi["products"]>>;
  allowed: number[];
  flow: string;
}): Trace["checks"] {
  const toolSteps = opts.steps.filter((s) => s.kind === "tool");
  const checks: Trace["checks"] = [];
  const names = toolSteps.map((s) => s.name);
  checks.push({
    name: "outils_chainés",
    ok: toolSteps.length >= 2 || names.some((n) => n === "confirm_order" || n === "order_status"),
    detail: `${toolSteps.length} outil(s) : ${names.join(" → ") || "aucun"}`,
  });
  const format = checkWhatsAppFormat(opts.reply);
  checks.push({ name: "format_whatsapp", ...format });
  checks.push({
    name: "réponse_complète",
    ok: opts.reply.trim().length >= 20,
    detail: opts.reply.trim().length >= 20 ? `${opts.reply.length} caractères` : "réponse vide ou tronquée",
  });
  const bad = ungroundedAmounts(opts.reply, opts.allowed);
  checks.push({
    name: "aucun_montant_inventé",
    ok: bad.length === 0,
    detail: bad.length ? `montants non adossés à un outil : ${bad.join(", ")}` : "tous les montants viennent des outils",
  });
  const math = opts.orders.map((o) => ({ o, r: checkOrderMath(o, opts.products) }));
  checks.push({
    name: "total_articles+livraison",
    ok: math.every((m) => m.r.ok),
    detail: math.length ? math.map((m) => `${m.o.code}: ${m.r.detail}`).join(" | ") : "aucune commande créée",
  });
  const confirmed = opts.orders.filter((o) => o.status === "confirmee");
  checks.push({
    name: "validation_gérante",
    ok: confirmed.length === 0,
    detail:
      confirmed.length === 0
        ? "aucune commande validée sans la gérante (normal : elle valide depuis son WhatsApp)"
        : `commande(s) validée(s) par l'agent sans la gérante : ${confirmed.map((o) => o.code).join(", ")}`,
  });
  const waiting = opts.orders.filter((o) => o.status === "attente_gerante");
  checks.push({
    name: "accord_client",
    ok: waiting.length === 0 || waiting.every((o) => o.status === "attente_gerante"),
    detail: waiting.length ? `client a confirmé (${waiting.map((o) => o.code).join(", ")})` : "pas de confirmation client",
  });
  return checks;
}

export async function runSolo(input: RootInput): Promise<RunResult> {
  const cfg = input.cfg;
  const llm = input.llm ?? new LlmClient(cfg);
  const startedAt = Date.now();
  const collector: StepCollector = { steps: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const ctx = baseCtx(input, cfg);
  const history = await input.shop.conversation(input.chatId);

  for (const hit of scanInjection(input.userText)) recordSecurity(input, hit.kind, hit.detail);

  const result = await runLoop({
    llm,
    system: soloSystem(cfg) + (input.orderContext ? `\n\n${input.orderContext}` : ""),
    tools: SOLO_TOOLS,
    ctx,
    history,
    userText: input.userText,
    maxSteps: input.maxSteps ?? 6,
    collector,
    agentName: "vendeuse",
  });

  const orders = (await input.shop.listOrders()).filter((o) => o.chat_id === input.chatId);
  const allowed = collectAmounts(collector.steps);
  const normalized = normalizeWhatsApp(result.reply);
  const guarded = await enforceGroundedNumbers(normalized, allowed, llm, (s) => record(collector, s));
  const reply = guarded.reply.trim() ? normalizeWhatsApp(guarded.reply) : "Un instant, je vérifie avec la gérante et je reviens vers toi 🙏";

  await input.shop.appendConversation(input.chatId, [
    { role: "user", content: input.userText },
    { role: "assistant", content: reply },
  ]);

  const checks = checksFor({
    input,
    reply,
    steps: collector.steps,
    orders,
    products: await input.shop.products(),
    allowed: collectAmounts(collector.steps),
    flow: "solo",
  });
  const trace = buildTrace({
    architecture: "solo",
    scenario: input.scenario,
    startedAt,
    collector,
    reply,
    checks,
    cost: llm.cost(collector.usage),
  });
  return { reply, trace, orders };
}

export async function runTeam(input: RootInput): Promise<RunResult> {
  const cfg = input.cfg;
  const llm = input.llm ?? new LlmClient(cfg);
  const startedAt = Date.now();
  const collector: StepCollector = { steps: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const ctx = baseCtx(input, cfg);
  const history = await input.shop.conversation(input.chatId);
  for (const hit of scanInjection(input.userText)) recordSecurity(input, hit.kind, hit.detail);

  const consulted = new Map<string, string>();
  const delegate = (opts: {
    name: string;
    description: string;
    system: string;
    tools: ToolDef[];
    agent: string;
    maxSteps: number;
  }): ToolDef => ({
    name: opts.name,
    description: opts.description,
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "Consigne précise et autonome pour le spécialiste, avec les faits déjà connus" } },
      required: ["request"],
      additionalProperties: false,
    },
    async execute(args) {
      if (!String(args.request ?? "").trim()) {
        return { error: "Consigne vide : écris précisément ce que tu attends de ce spécialiste." };
      }
      if (consulted.has(opts.name)) {
        return {
          reponse: consulted.get(opts.name),
          note: `Tu as déjà consulté ${opts.agent} pendant ce tour. Utilise cette réponse, ne le rappelle pas.`,
        };
      }
      const sub = await runLoop({
        llm,
        system: opts.system,
        tools: opts.tools,
        ctx,
        history: [],
        userText: String(args.request ?? ""),
        maxSteps: opts.maxSteps,
        collector,
        agentName: opts.agent,
        temperature: 0.1,
      });
      if (!sub.reply.trim()) return { error: `${opts.agent} n'a pas répondu. Fais sans lui et reste prudent sur les chiffres.` };
      consulted.set(opts.name, sub.reply);
      return { reponse: sub.reply, agent: opts.agent };
    },
  });

  const { searchProducts, checkStock, quoteDelivery, convertCurrency, prepareOrder, confirmOrder, orderStatus } = await import("../tools/index.ts");

  const managerTools: ToolDef[] = [
    delegate({
      name: "ask_seller",
      description: "Koffi, vendeur : catalogue, prix, stock, livraison, conversion, préparation du devis.",
      system: sellerSystem(cfg),
      tools: [searchProducts, checkStock, quoteDelivery, convertCurrency, prepareOrder, orderStatus],
      agent: "vendeur",
      maxSteps: 3,
    }),
    delegate({
      name: "ask_logistician",
      description: "Chantal, logisticienne : disponibilité, délais, frais, alternatives, faisabilité.",
      system: logisticianSystem(cfg),
      tools: [checkStock, quoteDelivery, orderStatus],
      agent: "logisticienne",
      maxSteps: 3,
    }),
    delegate({
      name: "ask_copywriter",
      description: "Élodie, rédactrice : réécrit le message final pour WhatsApp, sans changer aucun chiffre.",
      system: copywriterSystem(cfg),
      tools: [],
      agent: "rédactrice",
      maxSteps: 1,
    }),
    confirmOrder,
    orderStatus,
  ];

  const result = await runLoop({
    llm,
    system: managerSystem(cfg) + (input.orderContext ? `\n\n${input.orderContext}` : ""),
    tools: managerTools,
    ctx,
    history,
    userText: input.userText,
    maxSteps: input.maxSteps ?? 6,
    collector,
    agentName: "responsable",
  });

  const orders = (await input.shop.listOrders()).filter((o) => o.chat_id === input.chatId);
  const allowed = collectAmounts(collector.steps);
  const normalized = normalizeWhatsApp(result.reply);
  const guarded = await enforceGroundedNumbers(normalized, allowed, llm, (s) => record(collector, s));
  const reply = guarded.reply.trim() ? normalizeWhatsApp(guarded.reply) : "Un instant, je vérifie avec la gérante et je reviens vers toi 🙏";

  await input.shop.appendConversation(input.chatId, [
    { role: "user", content: input.userText },
    { role: "assistant", content: reply },
  ]);

  const checks = checksFor({
    input,
    reply,
    steps: collector.steps,
    orders,
    products: await input.shop.products(),
    allowed: collectAmounts(collector.steps),
    flow: "equipe",
  });
  const trace = buildTrace({
    architecture: "equipe",
    scenario: input.scenario,
    startedAt,
    collector,
    reply,
    checks,
    cost: llm.cost(collector.usage),
  });
  return { reply, trace, orders };
}
