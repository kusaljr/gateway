package cliagent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Shared driver for backends that speak the Agent Client Protocol over a child
// process's stdio (`cline --acp`, `copilot --acp`) rather than printing NDJSON
// and exiting.
//
// ACP is what these agents' own editor integrations use: it streams tool calls
// and permission requests as first-class messages, and a session keeps its
// context across prompts. Since it is a published spec rather than each
// vendor's private print format, one fold path serves every ACP backend —
// `session/update` carries the same agent_message_chunk / tool_call /
// tool_call_update kinds whichever agent is on the other end.
//
// What differs per backend is only how the server is started and how its model
// is chosen, which is what acpDriver describes.

// acpDriver is how one backend is driven over ACP.
type acpDriver struct {
	name string
	bin  string
	// args builds the argv (after bin) that starts the ACP server. Copilot
	// takes its model here, having no protocol call to change one; Cline
	// ignores the argument and uses session/set_model instead.
	args func(model string) []string
	// setModel: the backend can switch model on a live session
	// (session/set_model). When false, the model is fixed in argv at spawn, so
	// changing it means reopening the connection.
	setModel bool
	// canLoad: session/load actually restores a conversation, so a reopened
	// connection can pick up an existing thread instead of starting cold.
	// Cline advertises the capability but a prompt to a loaded session returns
	// end_turn with no content, so it stays false there.
	canLoad bool
}

type acpConn struct {
	name   string
	cmd    *exec.Cmd
	enc    *json.Encoder
	writeM sync.Mutex
	dec    *bufio.Scanner
	nextID int
}

func dialACP(name, bin, cwd string, args ...string) (*acpConn, error) {
	cmd := exec.Command(bin, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	return &acpConn{name: name, cmd: cmd, enc: json.NewEncoder(stdin), dec: sc, nextID: 1}, nil
}

// alive reports whether the child process is still running, so a pooled
// connection that died between turns is replaced rather than written to.
func (c *acpConn) alive() bool {
	return c.cmd.Process != nil && c.cmd.ProcessState == nil
}

func (c *acpConn) close() {
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	_ = c.cmd.Wait()
}

func (c *acpConn) send(v any) error {
	c.writeM.Lock()
	defer c.writeM.Unlock()
	return c.enc.Encode(v)
}

func (c *acpConn) request(method string, params any) (int, error) {
	id := c.nextID
	c.nextID++
	return id, c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

func (c *acpConn) reply(id json.RawMessage, result any) error {
	return c.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

type acpMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// next reads the next JSON-RPC message, skipping the plain-text notices these
// CLIs print before their stream begins.
func (c *acpConn) next() (*acpMessage, error) {
	for c.dec.Scan() {
		line := strings.TrimSpace(c.dec.Text())
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var m acpMessage
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			continue
		}
		return &m, nil
	}
	if err := c.dec.Err(); err != nil {
		return nil, err
	}
	return nil, io.EOF
}

func (m *acpMessage) idEquals(id int) bool {
	if len(m.Id()) == 0 {
		return false
	}
	var got int
	return json.Unmarshal(m.Id(), &got) == nil && got == id
}

func (m *acpMessage) Id() json.RawMessage { return m.ID }

type acpUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`
	Content       *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	ToolCallID string          `json:"toolCallId"`
	Title      string          `json:"title"`
	Status     string          `json:"status"`
	RawInput   map[string]any  `json:"rawInput"`
	RawOutput  json.RawMessage `json:"rawOutput"`
}

// A thread keeps its ACP process alive between turns.
//
// For Cline this is the only thing that works: session/load exists and reports
// success, but a prompt sent to a freshly loaded session returns stopReason
// "end_turn" with no content — verified against a clean session and a resumed
// one. Continuity only holds while the connection that created the session is
// open, which is how Cline's own editor integrations drive it.
//
// The cost is one idle agent process per active thread, reaped after
// acpIdleTTL. A backend with canLoad set (Copilot) can recover a thread after
// that reaping — or after a daemon restart — by loading its conversation id;
// without it, agent-side memory for the thread is lost, though kusal's own
// transcript survives so the visible history stays intact.
type acpSession struct {
	conn      *acpConn
	sessionID string
	model     string
	lastUsed  time.Time
}

const (
	acpIdleTTL   = 30 * time.Minute
	acpSweepTick = 5 * time.Minute
)

var (
	acpMu   sync.Mutex
	acpPool = map[string]*acpSession{}
	acpOnce sync.Once
)

func acpReapLoop() {
	for range time.Tick(acpSweepTick) {
		acpMu.Lock()
		for key, s := range acpPool {
			if time.Since(s.lastUsed) > acpIdleTTL {
				s.conn.close()
				delete(acpPool, key)
			}
		}
		acpMu.Unlock()
	}
}

// runACPTurn drives one turn on the thread's pooled connection, opening one
// (and its ACP session) the first time.
func runACPTurn(d acpDriver, sessionID, cwd, model, conversationID, text string, t *Transcript, flush func()) error {
	acpOnce.Do(func() { go acpReapLoop() })

	acpMu.Lock()
	defer acpMu.Unlock()

	// Keyed by backend as well as thread: a thread only ever belongs to one
	// backend, but this keeps a stale entry from ever being handed to the
	// wrong agent.
	key := d.name + ":" + sessionID

	sess := acpPool[key]
	if sess != nil && !sess.conn.alive() {
		sess.conn.close()
		delete(acpPool, key)
		sess = nil
	}
	// A backend that fixes its model in argv has to be respawned to change it.
	if sess != nil && model != "" && model != sess.model && !d.setModel {
		sess.conn.close()
		delete(acpPool, key)
		sess = nil
	}
	if sess == nil {
		opened, err := openACPSession(d, cwd, model, conversationID)
		if err != nil {
			return err
		}
		sess = opened
		acpPool[key] = sess
	} else if model != "" && model != sess.model {
		if err := sess.setModel(model); err != nil {
			return err
		}
	}
	sess.lastUsed = time.Now()
	t.ConversationID = sess.sessionID

	promptID, err := sess.conn.sendPrompt(sess.sessionID, text)
	if err != nil {
		sess.conn.close()
		delete(acpPool, key)
		return err
	}
	if err := sess.conn.pump(promptID, t, flush); err != nil {
		sess.conn.close()
		delete(acpPool, key)
		return err
	}
	sess.lastUsed = time.Now()
	return nil
}

// openACPSession starts the agent, handshakes, and either resumes
// conversationID or opens a fresh session.
func openACPSession(d acpDriver, cwd, model, conversationID string) (*acpSession, error) {
	conn, err := dialACP(d.name, d.bin, cwd, d.args(model)...)
	if err != nil {
		return nil, err
	}
	initID, err := conn.request("initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{},
		"clientInfo":         map[string]string{"name": "kusal", "title": "Kusal", "version": "1"},
	})
	if err != nil {
		conn.close()
		return nil, err
	}
	if _, err := conn.await(initID); err != nil {
		conn.close()
		return nil, err
	}

	sessionID := ""
	// Resuming keeps a thread's agent-side context across a reaped connection
	// or a daemon restart. await (rather than pump) is deliberate: a load
	// replays the whole conversation as session/update notifications, and
	// folding those would duplicate history kusal already stores itself.
	if d.canLoad && conversationID != "" {
		loadID, err := conn.request("session/load", map[string]any{
			"sessionId": conversationID, "cwd": cwd, "mcpServers": []any{},
		})
		if err == nil {
			if _, err := conn.await(loadID); err == nil {
				sessionID = conversationID
			}
		}
	}
	if sessionID == "" {
		newID, err := conn.request("session/new", map[string]any{"cwd": cwd, "mcpServers": []any{}})
		if err != nil {
			conn.close()
			return nil, err
		}
		res, err := conn.await(newID)
		if err != nil {
			conn.close()
			return nil, err
		}
		var parsed struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(res, &parsed)
		if parsed.SessionID == "" {
			conn.close()
			return nil, fmt.Errorf("%s acp returned no session id", d.name)
		}
		sessionID = parsed.SessionID
	}

	sess := &acpSession{conn: conn, sessionID: sessionID, model: model}
	// Without an explicit model the session uses the agent's configured
	// default, which may not be one the account can actually run — the turn
	// then ends silently with no content at all.
	if model != "" && d.setModel {
		if err := sess.setModel(model); err != nil {
			conn.close()
			return nil, err
		}
	}
	return sess, nil
}

func (s *acpSession) setModel(model string) error {
	id, err := s.conn.request("session/set_model", map[string]any{
		"sessionId": s.sessionID, "modelId": model,
	})
	if err != nil {
		return err
	}
	if _, err := s.conn.await(id); err != nil {
		return err
	}
	s.model = model
	return nil
}

// await reads until the response to id arrives, auto-answering any server
// request along the way and ignoring notifications.
func (c *acpConn) await(id int) (json.RawMessage, error) {
	return c.read(id, nil, nil)
}

// pump is await plus folding this turn's updates into the transcript.
func (c *acpConn) pump(id int, t *Transcript, flush func()) error {
	_, err := c.read(id, t, flush)
	return err
}

func (c *acpConn) read(id int, t *Transcript, flush func()) (json.RawMessage, error) {
	for {
		msg, err := c.next()
		if err != nil {
			return nil, fmt.Errorf("%s acp ended early: %w", c.name, err)
		}

		// server -> client requests (permission prompts, fs access)
		if msg.Method != "" && len(msg.ID) > 0 {
			if err := c.reply(msg.ID, acpAutoApprove(msg)); err != nil {
				return nil, err
			}
			continue
		}

		if msg.Method == "session/update" {
			if t == nil {
				continue
			}
			var p struct {
				Update acpUpdate `json:"update"`
			}
			if json.Unmarshal(msg.Params, &p) == nil {
				foldACPUpdate(p.Update, t)
				if flush != nil {
					flush()
				}
			}
			continue
		}

		if !msg.idEquals(id) {
			continue
		}
		if msg.Error != nil {
			return nil, fmt.Errorf("%s acp: %s", c.name, msg.Error.Message)
		}
		return msg.Result, nil
	}
}

func (c *acpConn) sendPrompt(sessionID, text string) (int, error) {
	return c.request("session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt":    []map[string]string{{"type": "text", "text": text}},
	})
}

// acpAutoApprove answers a server request. Permission prompts pick an allow
// option — headless has no one to ask, and this matches the auto-approval the
// other backends run with.
func acpAutoApprove(msg *acpMessage) map[string]any {
	if !strings.Contains(msg.Method, "permission") {
		return map[string]any{}
	}
	var p struct {
		Options []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	if json.Unmarshal(msg.Params, &p) != nil || len(p.Options) == 0 {
		return map[string]any{}
	}
	pick := p.Options[0]
	for _, o := range p.Options {
		if strings.Contains(strings.ToLower(o.Kind), "allow") {
			pick = o
			break
		}
	}
	return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": pick.OptionID}}
}

func foldACPUpdate(u acpUpdate, t *Transcript) {
	switch u.SessionUpdate {
	case "agent_message_chunk":
		if u.Content != nil {
			t.AppendText(u.Content.Text)
		}

	case "tool_call":
		t.ToolStart(u.ToolCallID, acpToolName(u.Title), u.RawInput)

	case "tool_call_update":
		if u.Title != "" || u.RawInput != nil {
			t.ToolStart(u.ToolCallID, acpToolName(u.Title), u.RawInput)
		}
		switch u.Status {
		case "completed":
			t.ToolEnd(u.ToolCallID, acpOutputText(u.RawOutput), false)
		case "failed", "error":
			t.ToolEnd(u.ToolCallID, acpOutputText(u.RawOutput), true)
		}

		// user_message_chunk / plan / thought: replayed or non-visual, skipped
	}
}

// acpToolName trims a "run_commands: echo hi" style title down to the tool name.
func acpToolName(title string) string {
	if name, _, ok := strings.Cut(title, ": "); ok && name != "" {
		return name
	}
	return title
}

// acpOutputText flattens rawOutput, which is an array of results on a live
// turn but a JSON string when replayed from a loaded session.
func acpOutputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var results []struct {
		Result  string `json:"result"`
		Success *bool  `json:"success"`
	}
	if json.Unmarshal(raw, &results) == nil {
		var sb strings.Builder
		for _, r := range results {
			sb.WriteString(r.Result)
		}
		return sb.String()
	}
	return string(raw)
}
