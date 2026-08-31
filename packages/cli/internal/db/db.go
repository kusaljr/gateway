package db

import (
	"database/sql"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"

	"kusal/internal/config"
)

func newID() string { return uuid.NewString() }

type Store struct{ DB *sql.DB }

type Device struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Hostname  string    `json:"hostname"`
	TunnelID  string    `json:"tunnel_id"`
	AccountID string    `json:"account_id"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	LastSeen  time.Time `json:"last_seen"`
}

// Open returns a store for the kusal database.
//
// The pragmas are not optional. Every caller opens its OWN pool (there are
// two dozen call sites, each with its own defer Close), so several connections
// write to this one file at once: a turn saving agent state, the poller
// flipping session status, the usage screen filling its per-file cache. In
// SQLite's default rollback-journal mode a writer takes an exclusive lock on
// the whole database, and the default busy timeout is ZERO — so the second
// writer does not wait, it fails immediately with "database is locked". That
// error surfaced in the app as a thread refusing to start or resume.
//
// WAL lets readers run against a snapshot while one writer appends, and
// busy_timeout makes a would-be second writer wait its turn instead of
// erroring. journal_mode is a property of the file itself, so the first open
// converts it and every later connection inherits it.
func Open() (*Store, error) {
	if err := config.EnsureDir(); err != nil {
		return nil, err
	}
	dsn := (&url.URL{Scheme: "file", Path: config.DBPath()}).String() +
		"?_pragma=journal_mode(WAL)" +
		"&_pragma=busy_timeout(5000)" +
		"&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection per pool: within a process this serializes writes so they
	// queue in Go rather than racing into SQLITE_BUSY, and it keeps the pool
	// from holding read connections open against the WAL checkpointer.
	db.SetMaxOpenConns(1)
	s := &Store{DB: db}
	// The very first open on an old database converts it from rollback-journal
	// to WAL, and that conversion takes an exclusive lock. Callers starting at
	// the same moment — the daemon boots several at once — can lose that race
	// even though every later write is fine. One short retry covers the
	// changeover; a genuine failure still surfaces on the second attempt.
	if err := s.migrate(); err != nil {
		if !isBusy(err) {
			return nil, err
		}
		time.Sleep(250 * time.Millisecond)
		if err := s.migrate(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func isBusy(err error) bool {
	return err != nil && strings.Contains(err.Error(), "database is locked")
}

func (s *Store) migrate() error {
	_, err := s.DB.Exec(`
	CREATE TABLE IF NOT EXISTS devices (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		hostname TEXT NOT NULL,
		tunnel_id TEXT,
		account_id TEXT,
		status TEXT DEFAULT 'disconnected',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS kv (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	CREATE TABLE IF NOT EXISTS projects (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		path TEXT NOT NULL UNIQUE,
		device_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
		title TEXT NOT NULL,
		provider TEXT DEFAULT 'opencode',
		status TEXT DEFAULT 'idle',
		model TEXT,
		cwd TEXT,
		branch TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
	CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
	-- agy has no server to hold conversation state or history, so kusal owns
	-- both: its conversation id (replayed via --conversation on the next turn)
	-- and the whole transcript as opencode-shaped messages JSON. One row per
	-- session; opencode threads never touch this table.
	CREATE TABLE IF NOT EXISTS agy_state (
		session_id TEXT PRIMARY KEY,
		conversation_id TEXT,
		messages TEXT,
		running INTEGER DEFAULT 0,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`)
	if err != nil {
		return err
	}
	// added after the first release: SQLite has no "ADD COLUMN IF NOT EXISTS",
	// so a duplicate-column error here just means the DB already has it.
	if _, err := s.DB.Exec(`ALTER TABLE sessions ADD COLUMN archived_at DATETIME`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		return err
	}
	// cache for parsed agent-CLI history (see usagecache.go)
	if err := s.initUsageCache(); err != nil {
		return err
	}
	return nil
}

type Project struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Path      string    `json:"path"`
	DeviceID  string    `json:"device_id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Session struct {
	ID         string     `json:"id"`
	ProjectID  string     `json:"project_id"`
	Title      string     `json:"title"`
	Provider   string     `json:"provider"`
	Status     string     `json:"status"`
	Model      string     `json:"model"`
	Cwd        string     `json:"cwd"`
	Branch     string     `json:"branch"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	ArchivedAt *time.Time `json:"archived_at,omitempty"`
}

func (s *Store) SetKV(k, v string) error {
	_, err := s.DB.Exec(`INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, v)
	return err
}
func (s *Store) GetKV(k string) string {
	var v string
	_ = s.DB.QueryRow(`SELECT value FROM kv WHERE key=?`, k).Scan(&v)
	return v
}

// DeleteKV removes specific keys. Missing keys are not an error — callers use
// this to clear whatever subset of a torn-down connection actually got written.
func (s *Store) DeleteKV(keys ...string) error {
	for _, k := range keys {
		if _, err := s.DB.Exec(`DELETE FROM kv WHERE key=?`, k); err != nil {
			return err
		}
	}
	return nil
}

// DeleteKVPrefix removes every key under a prefix — used to revoke the whole
// auth_session:* family at once, so a removed connection leaves no session that
// would still authenticate.
func (s *Store) DeleteKVPrefix(prefix string) error {
	_, err := s.DB.Exec(`DELETE FROM kv WHERE key LIKE ? || '%'`, prefix)
	return err
}

func (s *Store) DeleteDevice(id string) error {
	_, err := s.DB.Exec(`DELETE FROM devices WHERE id=?`, id)
	return err
}

func (s *Store) UpsertDevice(d Device) error {
	_, err := s.DB.Exec(`INSERT INTO devices(id,name,hostname,tunnel_id,account_id,status,last_seen) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
	ON CONFLICT(id) DO UPDATE SET name=excluded.name, hostname=excluded.hostname, tunnel_id=excluded.tunnel_id, account_id=excluded.account_id, status=excluded.status, last_seen=CURRENT_TIMESTAMP`,
		d.ID, d.Name, d.Hostname, d.TunnelID, d.AccountID, d.Status)
	return err
}

func (s *Store) ListDevices() ([]Device, error) {
	rows, err := s.DB.Query(`SELECT id,name,hostname,tunnel_id,account_id,status,created_at,last_seen FROM devices ORDER BY last_seen DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.Name, &d.Hostname, &d.TunnelID, &d.AccountID, &d.Status, &d.CreatedAt, &d.LastSeen); err != nil {
			continue
		}
		out = append(out, d)
	}
	return out, nil
}

func (s *Store) UpdateStatus(id, status string) error {
	_, err := s.DB.Exec(`UPDATE devices SET status=?, last_seen=CURRENT_TIMESTAMP WHERE id=?`, status, id)
	return err
}

// -- projects --

func (s *Store) UpsertProject(p Project) error {
	_, err := s.DB.Exec(`INSERT INTO projects(id,name,path,device_id) VALUES(?,?,?,?)
	ON CONFLICT(path) DO UPDATE SET name=excluded.name, device_id=excluded.device_id, updated_at=CURRENT_TIMESTAMP`,
		p.ID, p.Name, p.Path, p.DeviceID)
	return err
}

func (s *Store) EnsureProject(path, deviceID string) (*Project, error) {
	if path == "" {
		path = "."
	}
	// Derive name from base
	name := path
	if idx := lastSlash(path); idx >= 0 {
		name = path[idx+1:]
		if name == "" {
			name = path
		}
	}
	// try fetch existing
	var p Project
	err := s.DB.QueryRow(`SELECT id,name,path,device_id,created_at,updated_at FROM projects WHERE path=?`, path).Scan(&p.ID, &p.Name, &p.Path, &p.DeviceID, &p.CreatedAt, &p.UpdatedAt)
	if err == nil {
		return &p, nil
	}
	// create
	id := newID()
	if err := s.UpsertProject(Project{ID: id, Name: name, Path: path, DeviceID: deviceID}); err != nil {
		return nil, err
	}
	_ = s.DB.QueryRow(`SELECT id,name,path,device_id,created_at,updated_at FROM projects WHERE id=?`, id).Scan(&p.ID, &p.Name, &p.Path, &p.DeviceID, &p.CreatedAt, &p.UpdatedAt)
	return &p, nil
}

func lastSlash(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '/' {
			return i
		}
	}
	return -1
}

// DeleteProject removes a project and detaches its sessions rather than
// deleting them — the schema's ON DELETE SET NULL never fires since foreign
// keys aren't turned on for this connection, so it's done explicitly here.
func (s *Store) DeleteProject(id string) error {
	if _, err := s.DB.Exec(`UPDATE sessions SET project_id=NULL WHERE project_id=?`, id); err != nil {
		return err
	}
	_, err := s.DB.Exec(`DELETE FROM projects WHERE id=?`, id)
	return err
}

func (s *Store) ListProjects() ([]Project, error) {
	rows, err := s.DB.Query(`SELECT id,name,path,device_id,created_at,updated_at FROM projects ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Project
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.DeviceID, &p.CreatedAt, &p.UpdatedAt); err != nil {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// -- sessions (sqlite-backed, not opencode history) --

func (s *Store) CreateSession(sess Session) error {
	if sess.ID == "" {
		sess.ID = newID()
	}
	_, err := s.DB.Exec(`INSERT INTO sessions(id,project_id,title,provider,status,model,cwd,branch) VALUES(?,?,?,?,?,?,?,?)`,
		sess.ID, sess.ProjectID, sess.Title, sess.Provider, sess.Status, sess.Model, sess.Cwd, sess.Branch)
	return err
}

func (s *Store) ListSessions() ([]Session, error) {
	rows, err := s.DB.Query(`SELECT id,project_id,title,provider,status,model,cwd,branch,created_at,updated_at,archived_at FROM sessions ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var se Session
		var archivedAt sql.NullTime
		if err := rows.Scan(&se.ID, &se.ProjectID, &se.Title, &se.Provider, &se.Status, &se.Model, &se.Cwd, &se.Branch, &se.CreatedAt, &se.UpdatedAt, &archivedAt); err != nil {
			continue
		}
		if archivedAt.Valid {
			t := archivedAt.Time
			se.ArchivedAt = &t
		}
		out = append(out, se)
	}
	return out, nil
}

func (s *Store) ListSessionsByProject(projectID string) ([]Session, error) {
	rows, err := s.DB.Query(`SELECT id,project_id,title,provider,status,model,cwd,branch,created_at,updated_at,archived_at FROM sessions WHERE project_id=? ORDER BY updated_at DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var se Session
		var archivedAt sql.NullTime
		if err := rows.Scan(&se.ID, &se.ProjectID, &se.Title, &se.Provider, &se.Status, &se.Model, &se.Cwd, &se.Branch, &se.CreatedAt, &se.UpdatedAt, &archivedAt); err != nil {
			continue
		}
		if archivedAt.Valid {
			t := archivedAt.Time
			se.ArchivedAt = &t
		}
		out = append(out, se)
	}
	return out, nil
}

func (s *Store) TouchSession(id string) error {
	_, err := s.DB.Exec(`UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE id=?`, id)
	return err
}

// SetSessionArchived flips a thread in or out of the sidebar's archive.
func (s *Store) SetSessionArchived(id string, archived bool) error {
	if archived {
		_, err := s.DB.Exec(`UPDATE sessions SET archived_at=CURRENT_TIMESTAMP WHERE id=?`, id)
		return err
	}
	_, err := s.DB.Exec(`UPDATE sessions SET archived_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`, id)
	return err
}

func (s *Store) UpdateSessionTitle(id, title string) error {
	_, err := s.DB.Exec(`UPDATE sessions SET title=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, title, id)
	return err
}

func (s *Store) UpdateSessionModel(id, model string) error {
	_, err := s.DB.Exec(`UPDATE sessions SET model=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, model, id)
	return err
}

func (s *Store) UpdateSessionProvider(id, provider string) error {
	_, err := s.DB.Exec(`UPDATE sessions SET provider=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, provider, id)
	return err
}

func (s *Store) DeleteSession(id string) error {
	if _, err := s.DB.Exec(`DELETE FROM agy_state WHERE session_id=?`, id); err != nil {
		return err
	}
	_, err := s.DB.Exec(`DELETE FROM sessions WHERE id=?`, id)
	return err
}

func (s *Store) SessionProvider(id string) string {
	var p string
	_ = s.DB.QueryRow(`SELECT provider FROM sessions WHERE id=?`, id).Scan(&p)
	return p
}

// -- agy transcript state (see the agy_state table comment in migrate) --

type AgyState struct {
	ConversationID string
	Messages       string // opencode-shaped []Message as JSON
	Running        bool
}

func (s *Store) AgyState(sessionID string) AgyState {
	var st AgyState
	var running int
	_ = s.DB.QueryRow(`SELECT COALESCE(conversation_id,''), COALESCE(messages,''), COALESCE(running,0) FROM agy_state WHERE session_id=?`, sessionID).
		Scan(&st.ConversationID, &st.Messages, &running)
	st.Running = running == 1
	return st
}

func (s *Store) SaveAgyState(sessionID, conversationID, messages string, running bool) error {
	r := 0
	if running {
		r = 1
	}
	_, err := s.DB.Exec(`INSERT INTO agy_state(session_id,conversation_id,messages,running,updated_at)
	VALUES(?,?,?,?,CURRENT_TIMESTAMP)
	ON CONFLICT(session_id) DO UPDATE SET conversation_id=excluded.conversation_id, messages=excluded.messages, running=excluded.running, updated_at=CURRENT_TIMESTAMP`,
		sessionID, conversationID, messages, r)
	return err
}

func (s *Store) UpdateSessionStatus(id, status string) error {
	_, err := s.DB.Exec(`UPDATE sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, status, id)
	return err
}
