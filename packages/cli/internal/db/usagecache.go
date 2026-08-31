package db

// Cache of parsed agent-CLI history, keyed by file.
//
// The CLIs' own logs are append-only and can be very large — a single Codex
// rollout on a working machine reaches tens of megabytes — so the aggregate for
// a file is stored once and reused until the file changes. Size AND mtime both
// have to match: an append changes both, and matching on mtime alone would miss
// a rewrite inside the same second.
//
// The cached value is whatever JSON the caller hands over (agentusage.Row list);
// this package deliberately doesn't know that shape, which keeps the parsing
// rules in one place.

import (
	"database/sql"
	"strings"
)

func (s *Store) initUsageCache() error {
	_, err := s.DB.Exec(`
	CREATE TABLE IF NOT EXISTS agent_usage_files (
		path TEXT PRIMARY KEY,
		size INTEGER NOT NULL,
		mtime INTEGER NOT NULL,
		rows_json TEXT NOT NULL,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);`)
	return err
}

// GetUsageFile returns the cached JSON for path, but only if the file still has
// the same size and mtime it had when parsed.
func (s *Store) GetUsageFile(path string, size, mtime int64) (string, bool) {
	var rows string
	err := s.DB.QueryRow(
		`SELECT rows_json FROM agent_usage_files WHERE path = ? AND size = ? AND mtime = ?`,
		path, size, mtime,
	).Scan(&rows)
	if err != nil {
		if err != sql.ErrNoRows && !strings.Contains(err.Error(), "no such table") {
			return "", false
		}
		return "", false
	}
	return rows, true
}

func (s *Store) PutUsageFile(path string, size, mtime int64, rows string) {
	_, _ = s.DB.Exec(`
		INSERT INTO agent_usage_files (path, size, mtime, rows_json, updated_at)
		VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(path) DO UPDATE SET
			size = excluded.size,
			mtime = excluded.mtime,
			rows_json = excluded.rows_json,
			updated_at = CURRENT_TIMESTAMP`,
		path, size, mtime, rows)
}
