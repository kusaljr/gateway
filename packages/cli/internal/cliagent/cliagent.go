// Package cliagent drives coding-agent CLIs (claude, codex, agy, grok, copilot, cline)
// as chat backends alongside opencode.
//
// Each is the user's own locally-installed CLI, launched on the user's own
// machine under their own login. kusal never handles a provider credential,
// never calls a model API itself, and never resells access — it relays a
// prompt to a local process and renders what that process prints.
//
// They share a shape that is very different from opencode's: no `serve` mode,
// no HTTP API. Each turn spawns a process that streams NDJSON on stdout and
// exits, and continuity comes from a conversation/task id in its own output,
// replayed on the next turn via a flag. Since there is no server to query,
// this package also owns the transcript — events are folded into
// opencode-shaped messages so existing clients render these threads unchanged.
//
// A Backend supplies only what differs: how to invoke it, and how to fold one
// line of its output into the transcript. Everything else is shared.
package cliagent

import (
	"bufio"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// ── opencode-shaped transcript ─────────────────────────────────────────────
// Mirrors just enough of opencode's message/part JSON for the existing clients
// (see OCMessage/OCPart in the mobile and web api clients).

type PartState struct {
	Status string         `json:"status"` // running | completed | error
	Input  map[string]any `json:"input,omitempty"`
	Output string         `json:"output,omitempty"`
	Title  string         `json:"title,omitempty"`
}

type Part struct {
	ID    string     `json:"id"`
	Type  string     `json:"type"` // text | reasoning | tool
	Text  string     `json:"text,omitempty"`
	Tool  string     `json:"tool,omitempty"`
	State *PartState `json:"state,omitempty"`
}

type MessageInfo struct {
	Role      string `json:"role"`
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	Time      struct {
		Created   int64 `json:"created,omitempty"`
		Completed int64 `json:"completed,omitempty"`
	} `json:"time"`
}

type Message struct {
	Info  MessageInfo `json:"info"`
	Parts []Part      `json:"parts"`
}

// Transcript accumulates one assistant turn. Backends mutate it through the
// helpers below rather than touching Parts directly, so part identity and
// ordering rules stay in one place.
type Transcript struct {
	ConversationID string

	messages    []Message
	assistantAt int
	// stable key (tool call id, block index…) -> index into the assistant's Parts
	partOf map[string]int
	// the text part currently being streamed into, if any
	openText string
	seq      int
}

func (t *Transcript) Messages() []Message { return t.messages }

func (t *Transcript) assistant() *Message { return &t.messages[t.assistantAt] }

func (t *Transcript) nextID() string {
	t.seq++
	return fmt.Sprintf("%s-%d", t.assistant().Info.ID, t.seq)
}

// AppendText appends a delta to the open text part, starting one if needed.
// Backends that stream token-by-token call this repeatedly.
func (t *Transcript) AppendText(delta string) {
	if delta == "" {
		return
	}
	if t.openText == "" {
		t.openText = "text:" + t.nextID()
		t.messages[t.assistantAt].Parts = append(t.assistant().Parts, Part{ID: t.openText, Type: "text"})
		t.partOf[t.openText] = len(t.assistant().Parts) - 1
	}
	t.assistant().Parts[t.partOf[t.openText]].Text += delta
}

// SetText replaces the open text part's content with an authoritative value
// (several CLIs send the accumulated text again when a block ends) and closes
// it, so later text starts a new part.
func (t *Transcript) SetText(full string) {
	if strings.TrimSpace(full) == "" {
		t.CloseText()
		return
	}
	if t.openText == "" {
		t.AppendText(full)
	} else {
		t.assistant().Parts[t.partOf[t.openText]].Text = full
	}
	t.CloseText()
}

func (t *Transcript) CloseText() { t.openText = "" }

// HasText reports whether the turn produced any non-empty assistant text —
// used to decide whether a final "response" field is worth appending.
func (t *Transcript) HasText() bool {
	for _, p := range t.assistant().Parts {
		if p.Type == "text" && strings.TrimSpace(p.Text) != "" {
			return true
		}
	}
	return false
}

// ToolStart opens (or returns) the tool part for key. Any open text block is
// closed first so text before and after a tool stays in separate parts.
func (t *Transcript) ToolStart(key, name string, input map[string]any) {
	t.CloseText()
	k := "tool:" + key
	idx, ok := t.partOf[k]
	if !ok {
		t.messages[t.assistantAt].Parts = append(t.assistant().Parts, Part{
			ID:    t.nextID(),
			Type:  "tool",
			Tool:  name,
			State: &PartState{Status: "running", Title: name, Input: input},
		})
		idx = len(t.assistant().Parts) - 1
		t.partOf[k] = idx
		return
	}
	p := &t.assistant().Parts[idx]
	if name != "" {
		p.Tool, p.State.Title = name, name
	}
	if input != nil {
		p.State.Input = input
	}
}

// ToolOutput appends streamed output to an open tool part.
func (t *Transcript) ToolOutput(key, chunk string) {
	if chunk == "" {
		return
	}
	if idx, ok := t.partOf["tool:"+key]; ok {
		t.assistant().Parts[idx].State.Output += chunk
	}
}

// ToolEnd finalises a tool part. output replaces whatever streamed in when
// non-empty; failed marks it errored.
func (t *Transcript) ToolEnd(key, output string, failed bool) {
	idx, ok := t.partOf["tool:"+key]
	if !ok {
		return
	}
	p := &t.assistant().Parts[idx]
	if strings.TrimSpace(output) != "" {
		p.State.Output = output
	}
	if failed {
		p.State.Status = "error"
	} else {
		p.State.Status = "completed"
	}
}

// ── backends ───────────────────────────────────────────────────────────────

type Model struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// Backend is what every CLI agent has in common. How a turn is actually run
// then comes from one of the two interfaces below — most agents are one-shot
// processes (ExecBackend), but some speak a stdio protocol instead
// (Conversational).
type Backend interface {
	// Name is the providerID clients use to route a thread here ("claude", "codex", "grok", …).
	Name() string
	// Bin is the executable name, looked up on PATH.
	Bin() string
	// Models lists what this agent can run. May be empty if it can't be queried.
	Models() []Model
}

// ExecBackend runs a turn as one process: build argv, read NDJSON off stdout.
type ExecBackend interface {
	Backend
	// Args builds the argv (after Bin) for one turn. conversationID is empty
	// for a thread's first turn.
	Args(model, conversationID, text string) []string
	// Fold applies one line of stdout to the transcript. Lines arrive in
	// order; non-JSON noise should simply be ignored.
	Fold(line string, t *Transcript)
}

// Conversational runs a turn by speaking a request/response protocol over a
// child process's stdio — needed when an agent's headless mode can't resume a
// conversation from argv alone. The implementation owns its process, folds
// events into t as they arrive, sets t.ConversationID, and calls flush after
// each change so pollers see the turn progress.
type Conversational interface {
	Backend
	// sessionID is kusal's own thread id — stable across turns, so an
	// implementation that must keep a live connection can key it on that.
	RunTurn(sessionID, cwd, model, conversationID, text string, t *Transcript, flush func()) error
}

var registry = map[string]Backend{}

func register(b Backend) { registry[b.Name()] = b }

// Get returns the backend for a providerID, or nil if it isn't one of ours.
func Get(name string) Backend { return registry[name] }

// Installed lists the backends actually present on this machine, in a stable
// order so the model picker doesn't reshuffle between requests (see `order` in
// auth.go, which the provider inventory shares).
func Installed() []Backend {
	var out []Backend
	for _, name := range order {
		if b, ok := registry[name]; ok && IsInstalled(b) {
			out = append(out, b)
		}
	}
	return out
}

func IsInstalled(b Backend) bool {
	_, err := exec.LookPath(b.Bin())
	return err == nil
}

// ── model list caching ─────────────────────────────────────────────────────
// Listing models can mean shelling out to a network-backed command, so results
// are cached; the list only changes when the CLI itself is reconfigured.

type modelCache struct {
	mu     sync.Mutex
	models []Model
	at     time.Time
}

func (c *modelCache) get(load func() []Model) []Model {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.models != nil && time.Since(c.at) < 10*time.Minute {
		return c.models
	}
	if m := load(); len(m) > 0 {
		c.models, c.at = m, time.Now()
	}
	return c.models // keep any stale list rather than blanking the picker
}

// boundedBuffer keeps only the tail of what's written to it: agent stderr can
// be megabytes of progress noise, and only the end is ever diagnostic.
type boundedBuffer struct {
	buf []byte
}

const maxStderr = 8 * 1024

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if len(b.buf) > maxStderr {
		b.buf = b.buf[len(b.buf)-maxStderr:]
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string { return string(b.buf) }

// ── the shared run loop ────────────────────────────────────────────────────

// Run executes one turn against a backend and folds its output into the
// transcript, blocking until the process exits.
//
// onUpdate is called after every line with the full current transcript so the
// caller can persist it — clients poll that snapshot, since none of these CLIs
// offers anything like opencode's /event SSE.
//
// The conversation id the agent reports is returned for the next turn.
func Run(b Backend, sessionID, cwd, model, conversationID, text string, prior []Message, onUpdate func(conversationID string, messages []Message)) (string, error) {
	if !IsInstalled(b) {
		return conversationID, fmt.Errorf("%s is not installed", b.Bin())
	}

	now := time.Now().UnixMilli()
	t := &Transcript{ConversationID: conversationID, partOf: map[string]int{}}
	t.messages = append([]Message{}, prior...)

	user := Message{
		Info:  MessageInfo{Role: "user", ID: fmt.Sprintf("%s-u-%d", b.Name(), now), SessionID: sessionID},
		Parts: []Part{{ID: fmt.Sprintf("%s-u-%d-0", b.Name(), now), Type: "text", Text: text}},
	}
	user.Info.Time.Created, user.Info.Time.Completed = now, now
	t.messages = append(t.messages, user)

	assistant := Message{Info: MessageInfo{Role: "assistant", ID: fmt.Sprintf("%s-a-%d", b.Name(), now), SessionID: sessionID}}
	assistant.Info.Time.Created = now
	t.messages = append(t.messages, assistant)
	t.assistantAt = len(t.messages) - 1

	flush := func() {
		if onUpdate == nil {
			return
		}
		snapshot := make([]Message, len(t.messages))
		copy(snapshot, t.messages)
		snapshot[t.assistantAt].Parts = append([]Part{}, t.assistant().Parts...)
		onUpdate(t.ConversationID, snapshot)
	}
	flush()

	var runErr error
	var detail string
	switch impl := b.(type) {
	case Conversational:
		runErr = impl.RunTurn(sessionID, cwd, model, conversationID, text, t, flush)
		if runErr != nil {
			detail = runErr.Error()
		}
	case ExecBackend:
		detail, runErr = runExec(impl, cwd, model, conversationID, text, t, flush)
	default:
		runErr = fmt.Errorf("%s has no run implementation", b.Name())
		detail = runErr.Error()
	}

	t.CloseText()
	// A turn that produced nothing at all almost always means the process
	// failed to start its work (bad flag, expired auth, crash). Surfacing the
	// detail turns a blank reply into something diagnosable.
	if len(t.assistant().Parts) == 0 {
		switch {
		case strings.TrimSpace(detail) != "":
			t.SetText(strings.TrimSpace(detail))
		case runErr != nil:
			t.SetText(b.Bin() + " exited without output: " + runErr.Error())
		default:
			// The agent ended its turn cleanly but produced nothing at all.
			// Seen when a model is listed and accepted but isn't actually
			// runnable on the account (Cline reports no error for this — it
			// just ends the turn). Silence here reads as a hung app, so say so.
			msg := b.Name() + " ended the turn without producing any output."
			if model != "" {
				msg += " The model " + model + " may not be available on this account — try another."
			}
			t.SetText(msg)
		}
	}
	t.messages[t.assistantAt].Info.Time.Completed = time.Now().UnixMilli()
	flush()
	return t.ConversationID, runErr
}

// runExec is the one-shot path: spawn, read NDJSON off stdout, fold each line.
// It returns the stderr tail so a silent failure can still be reported.
func runExec(b ExecBackend, cwd, model, conversationID, text string, t *Transcript, flush func()) (string, error) {
	cmd := exec.Command(b.Bin(), b.Args(model, conversationID, text)...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	// Captured so a process that dies before emitting any JSON doesn't leave a
	// silent empty bubble — a bad flag, a failed auth or a crash all report on
	// stderr only, and that text is the single most useful thing to show.
	var stderr boundedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return "", err
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024) // tool output can be large
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue // these CLIs also print plain-text notices to stdout
		}
		b.Fold(line, t)
		flush()
	}
	return stderr.String(), cmd.Wait()
}
