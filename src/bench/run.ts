import { mkdir, rm, writeFile } from "node:fs/promises";
import { loadConfig, requireLlmConfig, type AppConfig } from "../config.ts";
import { LlmClient } from "../llm.ts";
import { ShopCore } from "../shop/core.ts";
import { FileStore } from "../shop/file.ts";
import { LocalShopApi } from "../shop/api.ts";
import { answerCustomer, type AgentMode } from "../orchestrator.ts";
import { judgeTurn, type JudgeResult } from "../agent/judge.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";
import type { Trace, TraceStep } from "../types.ts";

export type ScenarioScore = {
  scenario: string;
  title: string;
  mode: AgentMode;
  quality: JudgeResult | null;
  latency_ms: number;
  cost_xof: number;
  tools: string[];
  checks_ok: number;
  checks_total: number;
  replies: string[];
  trace_file: string;
};

export type BenchReport = {
  at: string;
  model: string;
  runs: ScenarioScore[];
  summary: {
    mode: AgentMode;
    quality: number;
    latency_ms: number;
    cost_xof: number;
    tools: number;
    checks_pct: number;
    score_global: number;
  }[];
  verdict: string;
};

const CHAT = "22997000000@c.us";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runBench(opts: { modes?: AgentMode[]; only?: string[]; verbose?: boolean } = {}): Promise<BenchReport> {
  const cfg = loadConfig(process.env);
  requireLlmConfig(cfg);
  const llm = new LlmClient(cfg);
  const modes = opts.modes ?? ["solo", "equipe"];
  const scenarios = opts.only?.length ? SCENARIOS.filter((s) => opts.only!.includes(s.id)) : SCENARIOS;

  await mkdir("traces", { recursive: true });
  const runs: ScenarioScore[] = [];

  for (const mode of modes) {
    for (const scenario of scenarios) {
      opts.verbose && console.error(`▶ ${mode} · ${scenario.id}`);
      const run = await runOne({ cfg, llm, mode, scenario, verbose: opts.verbose });
      runs.push(run);
      await sleep(400);
    }
  }

  const summary = modes.map((mode) => summarize(runs, mode));
  const verdict = decide(summary);
  const report: BenchReport = { at: new Date().toISOString(), model: cfg.model, runs, summary, verdict };
  await writeFile("bench/results.json", JSON.stringify(report, null, 2));
  await writeFile("bench/results.md", renderMarkdown(report));
  return report;
}

async function runOne(opts: { cfg: AppConfig; llm: LlmClient; mode: AgentMode; scenario: Scenario; verbose?: boolean }): Promise<ScenarioScore> {
  const { cfg, llm, mode, scenario } = opts;
  const slug = `bench-${mode}-${scenario.id}`;
  const storePath = `data/runtime/${slug}.json`;
  await rm(storePath, { force: true });
  const core = await new ShopCore(new FileStore(storePath)).init();

  const conversation: { role: "client" | "agent"; text: string }[] = [];
  const delivery = {
    send: async (_chatId: string, text: string) => {
      conversation.push({ role: "agent", text });
    },
    notifyManager: async () => {},
  };

  const shop = new LocalShopApi(core, async (chatId, text) => {
    await delivery.send(chatId, text);
  });

  const traces: Trace[] = [];
  for (const turn of scenario.turns) {
    conversation.push({ role: "client", text: turn });
    const res = await answerCustomer({ cfg, shop, chatId: CHAT, text: turn, name: "Client test", phone: "97000000", mode, scenario: scenario.id, delivery });
    traces.push(res.trace);
    opts.verbose && console.error(`  ${res.trace.duration_ms} ms · ${res.trace.steps.filter((s) => s.kind === "tool").length} outils · ${res.reply.slice(0, 60)}…`);
    await sleep(300);
  }

  const allSteps: TraceStep[] = traces.flatMap((t) => t.steps);
  const merged: Trace = { ...traces[traces.length - 1], steps: allSteps };
  let quality: JudgeResult | null = null;
  try {
    quality = await judgeTurn({
      llm,
      scenario: `${scenario.title}. ${scenario.checkpoints.join(" | ")}`,
      checkpoints: scenario.checkpoints,
      conversation,
      trace: merged,
    });
  } catch (err) {
    console.error("juge:", (err as Error).message);
  }

  const traceFile = `traces/${slug}.json`;
  await writeFile(traceFile, JSON.stringify({ scenario: scenario.title, mode, traces, quality }, null, 2));

  const checks = traces.flatMap((t) => t.checks);
  return {
    scenario: scenario.id,
    title: scenario.title,
    mode,
    quality,
    latency_ms: traces.reduce((s, t) => s + t.duration_ms, 0),
    cost_xof: traces.reduce((s, t) => s + t.cost_xof, 0) + (quality?.cost_xof ?? 0),
    tools: [...new Set(allSteps.filter((s) => s.kind === "tool").map((s) => s.name))],
    checks_ok: checks.filter((c) => c.ok).length,
    checks_total: checks.length,
    replies: conversation.filter((c) => c.role === "agent").map((c) => c.text),
    trace_file: traceFile,
  };
}

function summarize(runs: ScenarioScore[], mode: AgentMode) {
  const list = runs.filter((r) => r.mode === mode);
  const n = Math.max(1, list.length);
  return {
    mode,
    quality: round(list.reduce((s, r) => s + (r.quality?.score ?? 0), 0) / n, 2),
    latency_ms: Math.round(list.reduce((s, r) => s + r.latency_ms, 0) / n),
    cost_xof: round(list.reduce((s, r) => s + r.cost_xof, 0) / n, 2),
    tools: round(list.reduce((s, r) => s + r.tools.length, 0) / n, 1),
    checks_pct: Math.round((100 * list.reduce((s, r) => s + r.checks_ok, 0)) / Math.max(1, list.reduce((s, r) => s + r.checks_total, 0))),
    score_global: 0,
  };
}

function decide(summary: BenchReport["summary"]): string {
  const maxCost = Math.max(...summary.map((s) => s.cost_xof), 0.0001);
  const maxLat = Math.max(...summary.map((s) => s.latency_ms), 1);
  for (const s of summary) {
    s.score_global = round(
      (s.quality / 4) * 0.6 + (1 - s.cost_xof / maxCost) * 0.2 + (1 - s.latency_ms / maxLat) * 0.2,
      3,
    );
  }
  const [a, b] = summary;
  if (!b) return `Une seule architecture évaluée (${a.mode}) : qualité ${a.quality}/4, ${a.latency_ms} ms, ${a.cost_xof} FCFA.`;
  const best = a.score_global >= b.score_global ? a : b;
  const other = best === a ? b : a;
  const reasons: string[] = [];
  if (best.quality > other.quality) reasons.push(`meilleure qualité (${best.quality} vs ${other.quality}/4)`);
  if (best.cost_xof < other.cost_xof) reasons.push(`moins cher (${best.cost_xof} vs ${other.cost_xof} FCFA)`);
  if (best.latency_ms < other.latency_ms) reasons.push(`plus rapide (${(best.latency_ms / 1000).toFixed(1)} s vs ${(other.latency_ms / 1000).toFixed(1)} s)`);
  return `**${best.mode}** l'emporte (score ${best.score_global}) : ${reasons.join(", ") || "meilleur compromis global"}.`;
}

function renderMarkdown(r: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# Comparaison agent solo vs équipe multi-agents`);
  lines.push("");
  lines.push(`Modèle : \`${r.model}\` · généré le ${new Date(r.at).toLocaleString("fr-FR")} · 5 scénarios, mêmes données, même modèle.`);
  lines.push("");
  lines.push(`| Scénario | Architecture | Qualité (juge /4) | Latence | Coût | Outils | Garde-fous |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const run of r.runs) {
    lines.push(
      `| ${run.title} | ${run.mode} | ${run.quality?.score ?? "—"} | ${(run.latency_ms / 1000).toFixed(1)} s | ${run.cost_xof.toFixed(1)} FCFA | ${run.tools.length} | ${run.checks_ok}/${run.checks_total} |`,
    );
  }
  lines.push("");
  lines.push(`## Synthèse`);
  lines.push("");
  lines.push(`| Architecture | Qualité moyenne | Latence moyenne | Coût moyen | Outils / tour | Garde-fous OK | Score global |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const s of r.summary) {
    lines.push(
      `| ${s.mode} | ${s.quality}/4 | ${(s.latency_ms / 1000).toFixed(1)} s | ${s.cost_xof.toFixed(1)} FCFA | ${s.tools} | ${s.checks_pct} % | ${s.score_global} |`,
    );
  }
  lines.push("");
  lines.push(`**Verdict** : ${r.verdict}`);
  lines.push("");
  lines.push(`> Coût calculé sur les tokens réels (tarifs RodiumAI : 1 RODI = 0,01 USD, 1 USD ≈ 600 FCFA), juge LLM inclus.`);
  lines.push("");
  return lines.join("\n");
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
