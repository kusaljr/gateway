package agentusage

import (
	"database/sql"
	"path/filepath"
)

// ── GitHub Copilot CLI ─────────────────────────────────────────────────────
//
// Copilot keeps one central store at ~/.copilot/session-store.db — not a file
// per conversation — and since schema version 6 it writes a row per model
// request into `assistant_usage_events`, with model, the five token columns,
// and an ISO `created_at`. It still records AI units next to them
// (`total_nano_aiu`, `request_multiplier`), which is what it bills; those are
// deliberately left out here, since this package reports tokens and has
// nowhere honest to put a second currency.
//
// One trap in those columns: `input_tokens` is the WHOLE prompt, with the
// cached part already inside it. The same row's `token_details_json` breaks the
// billing out and proves it — a request logging input_tokens=17352 with
// cache_read_tokens=1280 details as input 16072 + cache_read 1280. Every other
// CLI here reports input as cache misses only, and Total sums input, output and
// both cache figures, so the cached tokens are subtracted back out below.
// Counting the column as-is would bill them twice.
//
// Checked against ground truth: the turn behind that row printed
//
//	Tokens  ↑ 17.4k (1.3k cached) • ↓ 162 (128 reasoning)
//
// which is exactly input_tokens / cache_read_tokens / output_tokens /
// reasoning_tokens as stored. Output already contains the reasoning tokens,
// same as Claude Code and Antigravity.

func copilotStore(home string) string {
	return filepath.Join(home, ".copilot", "session-store.db")
}

func parseCopilot(path string) []Row {
	conn, err := openConversation(path)
	if err != nil {
		return nil
	}
	defer conn.Close()

	rows, err := conn.Query(`
		SELECT model, input_tokens, output_tokens, cache_read_tokens,
		       cache_write_tokens, reasoning_tokens, created_at
		FROM assistant_usage_events`)
	if err != nil {
		// a Copilot old enough to predate the table, or a store mid-rewrite
		return nil
	}
	defer rows.Close()

	b := bucket{}
	for rows.Next() {
		var model, created sql.NullString
		var in, out, cacheRead, cacheWrite, reasoning sql.NullInt64
		if rows.Scan(&model, &in, &out, &cacheRead, &cacheWrite, &reasoning, &created) != nil {
			continue
		}
		date := localDate(created.String)
		if date == "" {
			continue
		}
		tok := Tokens{
			// the cached share is already inside input_tokens; take it back out
			// so it is counted once, in its own column
			Input:      nonNegative(in.Int64 - cacheRead.Int64 - cacheWrite.Int64),
			Output:     out.Int64,
			CacheRead:  cacheRead.Int64,
			CacheWrite: cacheWrite.Int64,
			Reasoning:  reasoning.Int64,
		}
		tok.Total = tok.Input + tok.Output + tok.CacheRead + tok.CacheWrite
		if tok.Total == 0 {
			continue
		}
		b.add("copilot", model.String, date, tok)
	}
	return b.rows()
}

func nonNegative(n int64) int64 {
	if n < 0 {
		return 0
	}
	return n
}

// copilotRecordsTokens answers whether this install's store is new enough to
// carry counts. A Copilot that predates the table genuinely cannot be metered
// and has to say so, but claiming that while its rows are already in the totals
// would contradict them.
func copilotRecordsTokens(path string) bool {
	conn, err := openConversation(path)
	if err != nil {
		return false
	}
	defer conn.Close()
	var name string
	err = conn.QueryRow(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_usage_events'`,
	).Scan(&name)
	return err == nil && name != ""
}
