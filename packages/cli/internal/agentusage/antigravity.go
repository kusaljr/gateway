package agentusage

import (
	"database/sql"
	"encoding/binary"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ── Gemini / Antigravity CLI ───────────────────────────────────────────────
//
// `agy` keeps no JSONL. Every conversation is its own SQLite database under
// ~/.gemini/antigravity-cli/conversations/<uuid>.db, and the Antigravity IDE
// writes the identical schema to ~/.gemini/antigravity-ide/conversations/.
// Both surfaces draw on the same subscription, so both fold into `agy`.
//
// The counts sit in gen_metadata.data — one row per model request — as a
// protobuf blob with no schema shipped anywhere on disk. The field numbers
// below were read off real stores and then checked against ground truth: the
// same turn run as `agy -p … --output-format json` answers
//
//	"usage":{"input_tokens":13730,"output_tokens":29,"thinking_tokens":28,
//	         "cache_read_tokens":0,"total_tokens":13759}
//
// and its row decodes to 4.2=13730, 4.3=29, 4.9=28, no 4.5 at all. So, inside
// the wrapper message at field 1:
//
//	4.2   input tokens, cache misses only
//	4.3   output tokens, thinking included
//	4.5   cache-read tokens; the field is absent when nothing was cached
//	4.9   thinking tokens — a subset of 4.3, never added on top of it
//	19    model id, e.g. "gemini-3.7-flash"
//	20    repeated key/value attributes, one of them `last_step_index`
//
// Field 9.10.1 also looks like a token count and is not one: it is the client's
// own estimate of context-window occupancy, which counts the whole conversation
// again on every request. Summing it would multiply the real input by the turn
// count.
//
// Nothing in the row carries a date. `last_step_index` points into the `steps`
// table, whose `metadata` blob opens with a protobuf Timestamp — that is the
// turn's clock, and on the stores measured here every request resolved through
// it.
//
// No price, as with every other CLI in this package: Antigravity bills against
// a subscription quota and writes no dollar figure anywhere.

func antigravityRoots(home string) []string {
	return []string{
		filepath.Join(home, ".gemini", "antigravity-cli", "conversations"),
		filepath.Join(home, ".gemini", "antigravity-ide", "conversations"),
	}
}

func parseAntigravity(path string) []Row {
	conn, err := openConversation(path)
	if err != nil {
		return nil
	}
	defer conn.Close()

	steps, newest := antigravitySteps(conn)
	rows, err := conn.Query("select data from gen_metadata order by idx")
	if err != nil {
		// not an Antigravity store, or a file being rewritten under us
		return nil
	}
	defer rows.Close()

	b := bucket{}
	for rows.Next() {
		var blob []byte
		if rows.Scan(&blob) != nil || len(blob) == 0 {
			continue
		}
		msg := pbBytes(blob, 1)
		if msg == nil {
			continue
		}
		u := pbBytes(msg, 4)
		tok := Tokens{
			Input:     pbInt(u, 2),
			Output:    pbInt(u, 3),
			CacheRead: pbInt(u, 5),
			// thinking is already inside output, kept apart so the mix row can
			// show it without inflating the total — same rule as Claude Code
			Reasoning: pbInt(u, 9),
		}
		tok.Total = tok.Input + tok.Output + tok.CacheRead + tok.CacheWrite
		if tok.Total == 0 {
			// a request that never reached the model writes a row with no
			// counts and no model name
			continue
		}
		sec, ok := steps[antigravityStepIndex(msg)]
		if !ok {
			// every store measured here resolved its own step, but a row whose
			// step was pruned still spent its tokens: date it by the
			// conversation's last step rather than dropping it
			sec = newest
		}
		if sec <= 0 {
			continue
		}
		b.add("agy", string(pbBytes(msg, 19)), time.Unix(sec, 0).Local().Format("2006-01-02"), tok)
	}
	return b.rows()
}

// antigravitySteps maps step index to wall-clock seconds. `metadata` field 1 is
// a protobuf Timestamp; only its seconds matter for a per-day bucket.
func antigravitySteps(conn *sql.DB) (map[int64]int64, int64) {
	out := map[int64]int64{}
	var newest int64
	rows, err := conn.Query("select idx, metadata from steps")
	if err != nil {
		return out, 0
	}
	defer rows.Close()
	for rows.Next() {
		var idx int64
		var blob []byte
		if rows.Scan(&idx, &blob) != nil || len(blob) == 0 {
			continue
		}
		sec := pbInt(pbBytes(blob, 1), 1)
		if sec <= 0 {
			continue
		}
		out[idx] = sec
		if sec > newest {
			newest = sec
		}
	}
	return out, newest
}

// The attribute list is the only place a request names the step it finished on.
func antigravityStepIndex(msg []byte) int64 {
	idx := int64(-1)
	pbScan(msg, func(num, wire int, _ uint64, data []byte) {
		if num != 20 || wire != 2 || idx >= 0 {
			return
		}
		if string(pbBytes(data, 1)) != "last_step_index" {
			return
		}
		if n, err := strconv.ParseInt(string(pbBytes(data, 2)), 10, 64); err == nil {
			idx = n
		}
	})
	return idx
}

// Read-only and never created: Antigravity is quite possibly writing this file
// while the scan runs. mode=ro still reads through the -wal, which is where a
// live conversation's newest rows are.
func openConversation(path string) (*sql.DB, error) {
	dsn := (&url.URL{Scheme: "file", Path: path}).String() + "?mode=ro&_pragma=busy_timeout(1000)"
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(1)
	return conn, nil
}

// scanDB is scan's counterpart for a CLI that keeps SQLite rather than JSONL.
// The freshness key covers the -wal as well as the .db: a live conversation's
// newest rows sit in the WAL while the .db's own size and mtime stand still, so
// a key built from the .db alone would pin a half-written cache entry in place
// and quietly lose every turn added afterwards.
func scanDB(root string, start time.Time, cache FileCache, parse func(path string) []Row) []Row {
	var out []Row
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(path, ".db") {
			return nil
		}
		out = append(out, scanDBFile(path, start, cache, parse)...)
		return nil
	})
	return out
}

// scanDBFile is the same for a CLI that keeps ONE central store rather than a
// file per conversation.
func scanDBFile(path string, start time.Time, cache FileCache, parse func(path string) []Row) []Row {
	size, mtime, ok := dbStamp(path)
	if !ok || time.Unix(mtime, 0).Before(start) {
		return nil
	}
	if rows, hit := cache.Get(path, size, mtime); hit {
		return rows
	}
	rows := parse(path)
	cache.Put(path, size, mtime, rows)
	return rows
}

func dbStamp(path string) (size, mtime int64, ok bool) {
	for _, p := range []string{path, path + "-wal"} {
		info, err := os.Stat(p)
		if err != nil {
			continue // no -wal is normal for an idle conversation
		}
		size += info.Size()
		if m := info.ModTime().Unix(); m > mtime {
			mtime = m
		}
	}
	return size, mtime, size > 0
}

// ── protobuf, without the schema ───────────────────────────────────────────
//
// Antigravity ships no .proto and no descriptor, so these blobs are walked at
// the wire level: field number, wire type, payload. Nothing here knows what a
// field means — the meanings are the table at the top of this file, established
// against ground truth. Every read is defensive; a truncated or unexpected
// blob ends the walk instead of panicking.

func pbScan(buf []byte, fn func(num, wire int, value uint64, data []byte)) {
	for len(buf) > 0 {
		key, n := binary.Uvarint(buf)
		if n <= 0 {
			return
		}
		buf = buf[n:]
		num, wire := int(key>>3), int(key&7)
		switch wire {
		case 0:
			v, n := binary.Uvarint(buf)
			if n <= 0 {
				return
			}
			buf = buf[n:]
			fn(num, wire, v, nil)
		case 1:
			if len(buf) < 8 {
				return
			}
			fn(num, wire, binary.LittleEndian.Uint64(buf), nil)
			buf = buf[8:]
		case 2:
			l, n := binary.Uvarint(buf)
			if n <= 0 || uint64(len(buf[n:])) < l {
				return
			}
			buf = buf[n:]
			fn(num, wire, 0, buf[:l])
			buf = buf[l:]
		case 5:
			if len(buf) < 4 {
				return
			}
			fn(num, wire, uint64(binary.LittleEndian.Uint32(buf)), nil)
			buf = buf[4:]
		default:
			return // groups: not used by this store, and unskippable here
		}
	}
}

// First occurrence wins in both of these. Every field read from this store
// appears at most once in its message.

func pbBytes(buf []byte, num int) []byte {
	var out []byte
	pbScan(buf, func(n, wire int, _ uint64, data []byte) {
		if n == num && wire == 2 && out == nil {
			out = data
		}
	})
	return out
}

func pbInt(buf []byte, num int) int64 {
	var out int64
	found := false
	pbScan(buf, func(n, wire int, value uint64, _ []byte) {
		if n == num && wire == 0 && !found {
			out, found = int64(value), true
		}
	})
	return out
}
