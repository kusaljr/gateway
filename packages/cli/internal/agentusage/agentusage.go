// Package agentusage reports what the agent CLIs on this machine have spent —
// every turn, not just the ones kusal itself drove.
//
// kusal only sees the turns it launched, so instrumenting its own runner would
// report a fraction of the truth. Each CLI already keeps its own local history,
// written whether the turn came from kusal, from a terminal, or from an editor
// integration, so that history is the honest source. Everything here is
// read-only: files the user already owns, parsed for counts and timestamps and
// nothing else.
//
// What each CLI actually records (verified against the real stores on disk, not
// assumed from docs):
//
//   - Claude Code — ~/.claude/projects/<slug>/<session>.jsonl, one JSON object
//     per line; `assistant` entries carry message.usage with input/output and
//     both cache figures, plus the model and an ISO timestamp. Metered.
//   - Codex — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; `event_msg`
//     entries of type token_count carry a session-cumulative total. Metered,
//     with the caveat handled in parseCodex.
//   - Copilot CLI — ~/.copilot/session-store.db, one central SQLite store; its
//     `assistant_usage_events` table carries a row per model request with all
//     five token counts. Metered, with the cache caveat handled in
//     parseCopilot. AI units sit in the same row and are left alone: this
//     package reports tokens, and has nowhere honest to put a second currency.
//   - Cline — session files hold model and timing but no counts at all.
//   - Grok CLI — keeps no session history to read.
//   - Antigravity / Gemini CLI (agy) — one SQLite database per conversation,
//     counts inside an unschema'd protobuf blob. Metered; see antigravity.go
//     for the decoded fields and how they were checked.
//   - Classic Gemini CLI — ~/.gemini/tmp/<hash>/logs.json records prompts and
//     no counts at all, so it stays unmetered when no Antigravity store sits
//     beside it.
//
// Cost is deliberately absent. These CLIs run on the user's own subscription
// and none of them writes a price into its local history, so any dollar figure
// here would be invented from a rate table kusal has no way to keep correct.
package agentusage

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Tokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
	Total      int64 `json:"total"`
}

func (t *Tokens) Add(o Tokens) {
	t.Input += o.Input
	t.Output += o.Output
	t.Reasoning += o.Reasoning
	t.CacheRead += o.CacheRead
	t.CacheWrite += o.CacheWrite
	t.Total += o.Total
}

// Row is one (provider, model, local date) bucket. Rows are what gets cached
// per file, so a file only ever needs parsing once.
type Row struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Date     string `json:"date"`
	Tokens   Tokens `json:"tokens"`
	Turns    int    `json:"turns"`
}

// Unmetered names a CLI that is installed but cannot be counted, with the
// reason. Saying so is the point: a provider missing from the totals with no
// explanation reads as "unused".
type Unmetered struct {
	Provider string `json:"provider"`
	Reason   string `json:"reason"`
}

// FileCache lets the caller keep parsed results between requests. One Codex
// rollout on a working machine is tens of megabytes, so re-reading every file
// on every request is not an option. Key is the file path; a cached entry is
// valid only while size and mtime both match.
type FileCache interface {
	Get(path string, size, mtime int64) ([]Row, bool)
	Put(path string, size, mtime int64, rows []Row)
}

type noCache struct{}

func (noCache) Get(string, int64, int64) ([]Row, bool) { return nil, false }
func (noCache) Put(string, int64, int64, []Row)        {}

// Collect returns per-day rows for the last `days` calendar days, today
// included, plus the CLIs that could not be counted.
func Collect(days int, cache FileCache) ([]Row, []Unmetered) {
	if days < 1 {
		days = 1
	}
	if cache == nil {
		cache = noCache{}
	}
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(days - 1))

	home, err := os.UserHomeDir()
	if err != nil {
		return nil, nil
	}

	var rows []Row
	rows = append(rows, scan(filepath.Join(home, ".claude", "projects"), start, cache, parseClaude)...)
	rows = append(rows, scan(filepath.Join(home, ".codex", "sessions"), start, cache, parseCodex)...)
	for _, root := range antigravityRoots(home) {
		rows = append(rows, scanDB(root, start, cache, parseAntigravity)...)
	}
	rows = append(rows, scanDBFile(copilotStore(home), start, cache, parseCopilot)...)

	// installed-but-uncountable, with the reason the client can show
	var unmetered []Unmetered
	add := func(dir, provider, reason string) {
		if _, err := os.Stat(filepath.Join(home, dir)); err == nil {
			unmetered = append(unmetered, Unmetered{Provider: provider, Reason: reason})
		}
	}
	// Copilot only started recording tokens at store schema 6; an older build
	// really does bill in AI units alone and has to say so.
	if _, err := os.Stat(filepath.Join(home, ".copilot")); err == nil && !copilotRecordsTokens(copilotStore(home)) {
		unmetered = append(unmetered, Unmetered{
			Provider: "copilot",
			Reason:   "this build records AI units and premium requests rather than tokens",
		})
	}
	add(".cline", "cline", "its session history stores no token counts")
	add(".grok", "grok", "keeps no session history to read")
	// ~/.gemini belongs to the classic Gemini CLI as much as to Antigravity,
	// and only the latter records counts. Naming agy unmetered while its own
	// rows are in the totals would contradict them, so this fires only when no
	// Antigravity store exists at all.
	if _, err := os.Stat(filepath.Join(home, ".gemini")); err == nil && !anyDir(antigravityRoots(home)) {
		unmetered = append(unmetered, Unmetered{
			Provider: "agy",
			Reason:   "the classic Gemini CLI logs prompts but no token counts",
		})
	}

	// keep only what falls inside the window — a file can hold older days too
	from := start.Format("2006-01-02")
	kept := make([]Row, 0, len(rows))
	for _, r := range rows {
		if r.Date >= from {
			kept = append(kept, r)
		}
	}
	return kept, unmetered
}

func anyDir(paths []string) bool {
	for _, p := range paths {
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			return true
		}
	}
	return false
}

// scan walks one CLI's history tree, using the cache for files whose size and
// mtime are unchanged. A file last written before the window cannot hold a day
// inside it, so it is skipped without being opened at all — that is what keeps
// this cheap on a machine with years of history.
func scan(root string, start time.Time, cache FileCache, parse func(path string) []Row) []Row {
	var out []Row
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// unreadable directory: skip it, never fail the whole collection
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.ModTime().Before(start) {
			return nil
		}
		size, mtime := info.Size(), info.ModTime().Unix()
		if rows, ok := cache.Get(path, size, mtime); ok {
			out = append(out, rows...)
			return nil
		}
		rows := parse(path)
		cache.Put(path, size, mtime, rows)
		out = append(out, rows...)
		return nil
	})
	return out
}

// bucket accumulates rows keyed by model+date while a file is parsed.
type bucket map[string]*Row

func (b bucket) add(provider, model, date string, tok Tokens) {
	if model == "" {
		model = "unknown"
	}
	key := model + "\x00" + date
	r := b[key]
	if r == nil {
		r = &Row{Provider: provider, Model: model, Date: date}
		b[key] = r
	}
	r.Tokens.Add(tok)
	r.Turns++
}

func (b bucket) rows() []Row {
	out := make([]Row, 0, len(b))
	for _, r := range b {
		out = append(out, *r)
	}
	return out
}

// lineReader streams a JSONL file. Both formats can write a single line far
// past bufio's default limit (a large tool result), hence the enlarged buffer;
// a line beyond even that cap is skipped rather than truncating the file.
func lineReader(path string) (*bufio.Scanner, *os.File, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 16*1024*1024)
	return sc, f, nil
}

func localDate(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return ""
	}
	return t.Local().Format("2006-01-02")
}

// Cheap pre-filters. These scan the whole line rather than a prefix: both
// formats put a long cwd, git branch and uuid set before the interesting keys,
// so a fixed-size head window silently misses them — that is what made every
// Codex row come back with an "unknown" model.
var (
	needleUsage      = []byte(`"usage"`)
	needleTokenCount = []byte("token_count")
	needleModel      = []byte(`"model"`)
)

// ── Claude Code ────────────────────────────────────────────────────────────

type claudeLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			OutputTokensDetails      *struct {
				ThinkingTokens int64 `json:"thinking_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	} `json:"message"`
}

func parseClaude(path string) []Row {
	sc, f, err := lineReader(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	b := bucket{}
	for sc.Scan() {
		line := sc.Bytes()
		// cheap reject before spending a JSON parse: tool results, snapshots
		// and user turns are the bulk of these files and carry no usage
		if !bytes.Contains(line, needleUsage) {
			continue
		}
		var e claudeLine
		if json.Unmarshal(line, &e) != nil || e.Type != "assistant" || e.Message == nil || e.Message.Usage == nil {
			continue
		}
		date := localDate(e.Timestamp)
		if date == "" {
			continue
		}
		u := e.Message.Usage
		tok := Tokens{
			Input:      u.InputTokens,
			Output:     u.OutputTokens,
			CacheRead:  u.CacheReadInputTokens,
			CacheWrite: u.CacheCreationInputTokens,
		}
		if u.OutputTokensDetails != nil {
			// thinking is already counted inside output_tokens; kept separately
			// so the mix row can show it without inflating the total
			tok.Reasoning = u.OutputTokensDetails.ThinkingTokens
		}
		tok.Total = tok.Input + tok.Output + tok.CacheRead + tok.CacheWrite
		if tok.Total == 0 {
			continue
		}
		b.add("claude", e.Message.Model, date, tok)
	}
	return b.rows()
}

// ── Codex ──────────────────────────────────────────────────────────────────

type codexLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Payload   struct {
		Type  string `json:"type"`
		Model string `json:"model"`
		Info  *struct {
			TotalTokenUsage *codexUsage `json:"total_token_usage"`
		} `json:"info"`
	} `json:"payload"`
}

type codexUsage struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
	TotalTokens           int64 `json:"total_tokens"`
}

// Codex reports a session-cumulative total on every token_count event, and it
// fires several per turn — summing the `last_token_usage` it also provides
// over-counts badly (measured on a real rollout: 353M summed against a 244M
// final total). So the delta between consecutive cumulative snapshots is what
// gets counted.
//
// That cumulative figure also RESETS mid-session when the context is compacted,
// which is why a drop is treated as "a counter restarting at this value" rather
// than as a correction: the pre-reset tokens were really spent. On the same
// rollout that recovers 351M, against the 244M the final snapshot alone claims.
func parseCodex(path string) []Row {
	sc, f, err := lineReader(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	b := bucket{}
	model := ""
	var prev codexUsage
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, needleTokenCount) && !bytes.Contains(line, needleModel) {
			continue
		}
		var e codexLine
		if json.Unmarshal(line, &e) != nil {
			continue
		}
		if e.Payload.Model != "" {
			model = e.Payload.Model
		}
		if e.Payload.Type != "token_count" || e.Payload.Info == nil || e.Payload.Info.TotalTokenUsage == nil {
			continue
		}
		cur := *e.Payload.Info.TotalTokenUsage
		date := localDate(e.Timestamp)
		if date == "" {
			prev = cur
			continue
		}
		tok := Tokens{
			Input:      delta(cur.InputTokens, prev.InputTokens),
			Output:     delta(cur.OutputTokens, prev.OutputTokens),
			Reasoning:  delta(cur.ReasoningOutputTokens, prev.ReasoningOutputTokens),
			CacheRead:  delta(cur.CachedInputTokens, prev.CachedInputTokens),
			CacheWrite: delta(cur.CacheWriteInputTokens, prev.CacheWriteInputTokens),
			Total:      delta(cur.TotalTokens, prev.TotalTokens),
		}
		prev = cur
		if tok.Total == 0 {
			// a repeat snapshot with nothing new — not a turn
			continue
		}
		b.add("codex", model, date, tok)
	}
	return b.rows()
}

// delta counts the increase, treating a drop as a counter that restarted at its
// current value.
func delta(cur, prev int64) int64 {
	if cur >= prev {
		return cur - prev
	}
	return cur
}
