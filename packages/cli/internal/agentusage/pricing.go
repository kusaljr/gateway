package agentusage

import (
	"strings"
)

// ModelRate defines the pricing per 1 Million tokens (in USD).
type ModelRate struct {
	Input      float64
	Output     float64
	Reasoning  float64
	CacheRead  float64
	CacheWrite float64
}

// EstimateCost calculates the estimated USD cost for a given provider, model,
// and token distribution based on official provider API rates.
func EstimateCost(provider, model string, t Tokens) float64 {
	rate := lookupRate(provider, model)

	// Price = (Tokens / 1,000,000) * RatePerMillion
	inputCost := (float64(t.Input) / 1_000_000.0) * rate.Input
	outputCost := (float64(t.Output) / 1_000_000.0) * rate.Output

	// Reasoning tokens bill at output rates unless specified differently
	reasoningRate := rate.Reasoning
	if reasoningRate == 0 {
		reasoningRate = rate.Output
	}
	reasoningCost := (float64(t.Reasoning) / 1_000_000.0) * reasoningRate

	// Cache read is typically 10% - 50% of input rate
	cacheReadRate := rate.CacheRead
	if cacheReadRate == 0 && rate.Input > 0 {
		cacheReadRate = rate.Input * 0.10
	}
	cacheReadCost := (float64(t.CacheRead) / 1_000_000.0) * cacheReadRate

	// Cache write is typically 1.25x of input rate
	cacheWriteRate := rate.CacheWrite
	if cacheWriteRate == 0 && rate.Input > 0 {
		cacheWriteRate = rate.Input * 1.25
	}
	cacheWriteCost := (float64(t.CacheWrite) / 1_000_000.0) * cacheWriteRate

	return inputCost + outputCost + reasoningCost + cacheReadCost + cacheWriteCost
}

func lookupRate(provider, model string) ModelRate {
	p := strings.ToLower(provider)
	m := strings.ToLower(model)

	// Normalize model name (strip provider prefixes if embedded like "anthropic/claude-3-7-sonnet")
	if idx := strings.LastIndex(m, "/"); idx != -1 {
		m = m[idx+1:]
	}

	// ── 1. Anthropic / Claude ────────────────────────────────────────────────
	if p == "claude" || strings.Contains(p, "anthropic") || strings.Contains(m, "claude") {
		switch {
		case strings.Contains(m, "opus"):
			return ModelRate{Input: 15.00, Output: 75.00, Reasoning: 75.00, CacheRead: 1.50, CacheWrite: 18.75}
		case strings.Contains(m, "haiku"):
			return ModelRate{Input: 0.80, Output: 4.00, Reasoning: 4.00, CacheRead: 0.08, CacheWrite: 1.00}
		case strings.Contains(m, "sonnet"):
			// Sonnet 3.5 / 3.7 / 4 / 5
			return ModelRate{Input: 3.00, Output: 15.00, Reasoning: 15.00, CacheRead: 0.30, CacheWrite: 3.75}
		default:
			return ModelRate{Input: 3.00, Output: 15.00, Reasoning: 15.00, CacheRead: 0.30, CacheWrite: 3.75}
		}
	}

	// ── 2. OpenAI / Codex ────────────────────────────────────────────────────
	if p == "codex" || strings.Contains(p, "openai") || strings.Contains(m, "gpt") || strings.Contains(m, "o1") || strings.Contains(m, "o3") {
		switch {
		case strings.Contains(m, "o1-mini") || strings.Contains(m, "o3-mini") || strings.Contains(m, "o4-mini"):
			return ModelRate{Input: 1.10, Output: 4.40, Reasoning: 4.40, CacheRead: 0.55, CacheWrite: 1.10}
		case strings.Contains(m, "o1") || strings.Contains(m, "o3"):
			return ModelRate{Input: 15.00, Output: 60.00, Reasoning: 60.00, CacheRead: 7.50, CacheWrite: 15.00}
		case strings.Contains(m, "4o-mini"):
			return ModelRate{Input: 0.15, Output: 0.60, Reasoning: 0.60, CacheRead: 0.075, CacheWrite: 0.15}
		case strings.Contains(m, "4o"):
			return ModelRate{Input: 2.50, Output: 10.00, Reasoning: 10.00, CacheRead: 1.25, CacheWrite: 2.50}
		case strings.Contains(m, "gpt-5"):
			return ModelRate{Input: 3.00, Output: 15.00, Reasoning: 15.00, CacheRead: 1.50, CacheWrite: 3.00}
		case strings.Contains(m, "gpt-4-turbo") || strings.Contains(m, "gpt-4"):
			return ModelRate{Input: 10.00, Output: 30.00, Reasoning: 30.00, CacheRead: 5.00, CacheWrite: 10.00}
		case strings.Contains(m, "3.5"):
			return ModelRate{Input: 0.50, Output: 1.50, Reasoning: 1.50, CacheRead: 0.25, CacheWrite: 0.50}
		default:
			return ModelRate{Input: 2.50, Output: 10.00, Reasoning: 10.00, CacheRead: 1.25, CacheWrite: 2.50}
		}
	}

	// ── 3. Google Gemini / Antigravity (agy) ──────────────────────────────────
	if p == "agy" || strings.Contains(p, "gemini") || strings.Contains(p, "google") || strings.Contains(m, "gemini") {
		switch {
		case strings.Contains(m, "flash-lite"):
			return ModelRate{Input: 0.0375, Output: 0.15, Reasoning: 0.15, CacheRead: 0.01, CacheWrite: 0.0375}
		case strings.Contains(m, "flash"):
			return ModelRate{Input: 0.075, Output: 0.30, Reasoning: 0.30, CacheRead: 0.01875, CacheWrite: 0.075}
		case strings.Contains(m, "pro") || strings.Contains(m, "ultra"):
			return ModelRate{Input: 1.25, Output: 5.00, Reasoning: 5.00, CacheRead: 0.3125, CacheWrite: 1.25}
		default:
			return ModelRate{Input: 0.50, Output: 2.00, Reasoning: 2.00, CacheRead: 0.125, CacheWrite: 0.50}
		}
	}

	// ── 4. DeepSeek ──────────────────────────────────────────────────────────
	if strings.Contains(p, "deepseek") || strings.Contains(m, "deepseek") {
		switch {
		case strings.Contains(m, "reasoner") || strings.Contains(m, "r1"):
			return ModelRate{Input: 0.55, Output: 2.19, Reasoning: 2.19, CacheRead: 0.14, CacheWrite: 0.55}
		default:
			return ModelRate{Input: 0.14, Output: 0.28, Reasoning: 0.28, CacheRead: 0.014, CacheWrite: 0.14}
		}
	}

	// ── 5. xAI / Grok ────────────────────────────────────────────────────────
	if p == "grok" || strings.Contains(p, "x-ai") || strings.Contains(m, "grok") {
		switch {
		case strings.Contains(m, "mini"):
			return ModelRate{Input: 0.20, Output: 1.00, Reasoning: 1.00, CacheRead: 0.05, CacheWrite: 0.20}
		default:
			return ModelRate{Input: 2.00, Output: 10.00, Reasoning: 10.00, CacheRead: 0.50, CacheWrite: 2.00}
		}
	}

	// ── 6. Copilot ───────────────────────────────────────────────────────────
	if p == "copilot" {
		switch {
		case strings.Contains(m, "claude"):
			return ModelRate{Input: 3.00, Output: 15.00, Reasoning: 15.00, CacheRead: 0.30, CacheWrite: 3.75}
		case strings.Contains(m, "gpt-4o-mini"):
			return ModelRate{Input: 0.15, Output: 0.60, Reasoning: 0.60, CacheRead: 0.075, CacheWrite: 0.15}
		default:
			return ModelRate{Input: 2.50, Output: 10.00, Reasoning: 10.00, CacheRead: 1.25, CacheWrite: 2.50}
		}
	}

	// Default fallback (balanced mid-tier rates: $2/1M in, $8/1M out)
	return ModelRate{Input: 2.00, Output: 8.00, Reasoning: 8.00, CacheRead: 0.40, CacheWrite: 2.00}
}
