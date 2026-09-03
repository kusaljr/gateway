import type { UsageTokens } from "@/lib/api";

export type ModelRate = {
  input: number; // USD per 1M tokens
  output: number; // USD per 1M tokens
  reasoning: number; // USD per 1M tokens
  cacheRead: number; // USD per 1M tokens
  cacheWrite: number; // USD per 1M tokens
  label?: string;
};

/**
 * Model API pricing table per million tokens (USD).
 */
export function getModelRate(provider: string, model: string): ModelRate {
  const p = (provider || "").toLowerCase();
  const m = (model || "").toLowerCase();

  // Normalize model name (remove provider prefixes if present, e.g. "anthropic/claude-3-7-sonnet")
  const cleanModel = m.includes("/") ? m.split("/").pop() || m : m;

  // 1. Anthropic / Claude
  if (p === "claude" || p.includes("anthropic") || cleanModel.includes("claude")) {
    if (cleanModel.includes("opus")) {
      return { input: 15.0, output: 75.0, reasoning: 75.0, cacheRead: 1.5, cacheWrite: 18.75, label: "Claude Opus ($15/$75 per 1M)" };
    }
    if (cleanModel.includes("haiku")) {
      return { input: 0.8, output: 4.0, reasoning: 4.0, cacheRead: 0.08, cacheWrite: 1.0, label: "Claude Haiku ($0.80/$4.00 per 1M)" };
    }
    // Sonnet (3.5, 3.7, 4, 5)
    return { input: 3.0, output: 15.0, reasoning: 15.0, cacheRead: 0.3, cacheWrite: 3.75, label: "Claude Sonnet ($3/$15 per 1M)" };
  }

  // 2. OpenAI / Codex
  if (p === "codex" || p.includes("openai") || cleanModel.includes("gpt") || cleanModel.startsWith("o1") || cleanModel.startsWith("o3") || cleanModel.startsWith("o4")) {
    if (cleanModel.includes("o1-mini") || cleanModel.includes("o3-mini") || cleanModel.includes("o4-mini")) {
      return { input: 1.1, output: 4.4, reasoning: 4.4, cacheRead: 0.55, cacheWrite: 1.1, label: "o3-mini ($1.10/$4.40 per 1M)" };
    }
    if (cleanModel.startsWith("o1") || cleanModel.startsWith("o3") || cleanModel.startsWith("o4")) {
      return { input: 15.0, output: 60.0, reasoning: 60.0, cacheRead: 7.5, cacheWrite: 15.0, label: "o1 / o3 ($15/$60 per 1M)" };
    }
    if (cleanModel.includes("4o-mini")) {
      return { input: 0.15, output: 0.6, reasoning: 0.6, cacheRead: 0.075, cacheWrite: 0.15, label: "GPT-4o-mini ($0.15/$0.60 per 1M)" };
    }
    if (cleanModel.includes("4o")) {
      return { input: 2.5, output: 10.0, reasoning: 10.0, cacheRead: 1.25, cacheWrite: 2.5, label: "GPT-4o ($2.50/$10 per 1M)" };
    }
    if (cleanModel.includes("gpt-5")) {
      return { input: 3.0, output: 15.0, reasoning: 15.0, cacheRead: 1.5, cacheWrite: 3.0, label: "GPT-5 ($3/$15 per 1M)" };
    }
    if (cleanModel.includes("gpt-4")) {
      return { input: 10.0, output: 30.0, reasoning: 30.0, cacheRead: 5.0, cacheWrite: 10.0, label: "GPT-4 Turbo ($10/$30 per 1M)" };
    }
    if (cleanModel.includes("3.5")) {
      return { input: 0.5, output: 1.5, reasoning: 1.5, cacheRead: 0.25, cacheWrite: 0.5, label: "GPT-3.5 Turbo ($0.50/$1.50 per 1M)" };
    }
    return { input: 2.5, output: 10.0, reasoning: 10.0, cacheRead: 1.25, cacheWrite: 2.5, label: "GPT-4o ($2.50/$10 per 1M)" };
  }

  // 3. Google Gemini / Antigravity
  if (p === "agy" || p.includes("gemini") || p.includes("google") || cleanModel.includes("gemini")) {
    if (cleanModel.includes("flash-lite")) {
      return { input: 0.0375, output: 0.15, reasoning: 0.15, cacheRead: 0.01, cacheWrite: 0.0375, label: "Gemini Flash Lite ($0.0375/$0.15 per 1M)" };
    }
    if (cleanModel.includes("flash")) {
      return { input: 0.075, output: 0.3, reasoning: 0.3, cacheRead: 0.01875, cacheWrite: 0.075, label: "Gemini Flash ($0.075/$0.30 per 1M)" };
    }
    if (cleanModel.includes("pro") || cleanModel.includes("ultra")) {
      return { input: 1.25, output: 5.0, reasoning: 5.0, cacheRead: 0.3125, cacheWrite: 1.25, label: "Gemini Pro ($1.25/$5.00 per 1M)" };
    }
    return { input: 0.5, output: 2.0, reasoning: 2.0, cacheRead: 0.125, cacheWrite: 0.5, label: "Gemini ($0.50/$2.00 per 1M)" };
  }

  // 4. DeepSeek
  if (p.includes("deepseek") || cleanModel.includes("deepseek")) {
    if (cleanModel.includes("reasoner") || cleanModel.includes("r1")) {
      return { input: 0.55, output: 2.19, reasoning: 2.19, cacheRead: 0.14, cacheWrite: 0.55, label: "DeepSeek R1 ($0.55/$2.19 per 1M)" };
    }
    return { input: 0.14, output: 0.28, reasoning: 0.28, cacheRead: 0.014, cacheWrite: 0.14, label: "DeepSeek V3 ($0.14/$0.28 per 1M)" };
  }

  // 5. xAI / Grok
  if (p === "grok" || p.includes("x-ai") || cleanModel.includes("grok")) {
    if (cleanModel.includes("mini")) {
      return { input: 0.2, output: 1.0, reasoning: 1.0, cacheRead: 0.05, cacheWrite: 0.2, label: "Grok Mini ($0.20/$1.00 per 1M)" };
    }
    return { input: 2.0, output: 10.0, reasoning: 10.0, cacheRead: 0.5, cacheWrite: 2.0, label: "Grok ($2/$10 per 1M)" };
  }

  // 6. Copilot
  if (p === "copilot") {
    if (cleanModel.includes("claude")) {
      return { input: 3.0, output: 15.0, reasoning: 15.0, cacheRead: 0.3, cacheWrite: 3.75, label: "Copilot / Claude ($3/$15 per 1M)" };
    }
    if (cleanModel.includes("mini")) {
      return { input: 0.15, output: 0.6, reasoning: 0.6, cacheRead: 0.075, cacheWrite: 0.15, label: "Copilot / 4o-mini ($0.15/$0.60 per 1M)" };
    }
    return { input: 2.5, output: 10.0, reasoning: 10.0, cacheRead: 1.25, cacheWrite: 2.5, label: "Copilot / GPT-4o ($2.50/$10 per 1M)" };
  }

  // Balanced fallback (Mid-tier $2.00 in / $8.00 out per 1M)
  return { input: 2.0, output: 8.0, reasoning: 8.0, cacheRead: 0.4, cacheWrite: 2.0, label: "Standard Rate ($2/$8 per 1M)" };
}

/**
 * Calculates estimated cost for given tokens and model rate.
 */
export function estimateTokenCost(provider: string, model: string, tokens: UsageTokens): number {
  const rate = getModelRate(provider, model);
  const inputCost = (tokens.input / 1_000_000) * rate.input;
  const outputCost = (tokens.output / 1_000_000) * rate.output;
  const reasoningCost = (tokens.reasoning / 1_000_000) * (rate.reasoning || rate.output);
  const cacheReadCost = (tokens.cache_read / 1_000_000) * rate.cacheRead;
  const cacheWriteCost = (tokens.cache_write / 1_000_000) * rate.cacheWrite;

  return inputCost + outputCost + reasoningCost + cacheReadCost + cacheWriteCost;
}
