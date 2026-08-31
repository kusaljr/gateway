package opencode

// Usage accounting.
//
// opencode meters every turn itself: each message carries the tokens it spent
// (input, output, reasoning, and cache read/write separately) and the cost it
// computed for them. So a day-by-day breakdown is a sum over real per-message
// numbers — nothing here estimates spend from text length.
//
// Two honesty constraints shape the output. Cost is opencode's own figure, and
// a subscription or free model reports $0 for a turn that really did spend
// tokens, so messages priced at zero are counted separately rather than
// quietly averaged in. And this covers opencode threads only: the CLI agents
// run under the user's own logins and report no usage kusal keeps, which the
// caller reports as an excluded count instead of a zero.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"time"
)

// Tokens is one bucket of token counts. Cache reads are billed differently from
// fresh input by every provider that offers them, so they stay separate all the
// way to the client instead of being folded into a single number.
type Tokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
	Total      int64 `json:"total"`
}

func (t *Tokens) add(o Tokens) {
	t.Input += o.Input
	t.Output += o.Output
	t.Reasoning += o.Reasoning
	t.CacheRead += o.CacheRead
	t.CacheWrite += o.CacheWrite
	t.Total += o.Total
}

type DayUsage struct {
	// device-local calendar date, YYYY-MM-DD
	Date   string  `json:"date"`
	Tokens Tokens  `json:"tokens"`
	Cost   float64 `json:"cost"`
	// turns counted, and how many of them opencode priced at zero
	Messages        int `json:"messages"`
	UnpricedMessage int `json:"unpriced_messages"`
}

// ProviderUsage is the same roll-up one level up: several models can belong to
// one provider, and "which provider is this month's spend" is the question the
// clients ask first.
type ProviderUsage struct {
	Provider string  `json:"provider"`
	Tokens   Tokens  `json:"tokens"`
	Cost     float64 `json:"cost"`
	Messages int     `json:"messages"`
	Models   int     `json:"models"`
}

type ModelUsage struct {
	Key      string  `json:"key"`
	Provider string  `json:"provider"`
	Model    string  `json:"model"`
	Tokens   Tokens  `json:"tokens"`
	Cost     float64 `json:"cost"`
	Messages int     `json:"messages"`
}

type Usage struct {
	From      string          `json:"from"`
	To        string          `json:"to"`
	Days      []DayUsage      `json:"days"`
	Providers []ProviderUsage `json:"providers"`
	Models    []ModelUsage    `json:"models"`
	Tokens    Tokens          `json:"tokens"`
	Cost      float64         `json:"cost"`
	// total turns in the window, and the share opencode priced at zero —
	// a client showing a dollar figure needs both to describe it honestly
	Messages         int `json:"messages"`
	UnpricedMessages int `json:"unpriced_messages"`
	SessionsScanned  int `json:"sessions_scanned"`
}

type ocMessageInfo struct {
	Role       string `json:"role"`
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
	Cost       float64
	Tokens     struct {
		Total     int64 `json:"total"`
		Input     int64 `json:"input"`
		Output    int64 `json:"output"`
		Reasoning int64 `json:"reasoning"`
		Cache     struct {
			Read  int64 `json:"read"`
			Write int64 `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
	Time struct {
		Created   int64 `json:"created"`
		Completed int64 `json:"completed"`
	} `json:"time"`
}

// Collect sums usage over the last `days` calendar days, today included.
//
// Every date in the window gets a row even when nothing ran on it, so a chart
// can plot a continuous axis without inventing the gaps itself.
func Collect(days int) (*Usage, error) {
	if days < 1 {
		days = 1
	}
	if days > 90 {
		days = 90
	}
	now := time.Now()
	// local midnight, days-1 back: "last 7 days" means today plus six before it
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(days - 1))

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(baseURL + "/session")
	if err != nil {
		return nil, fmt.Errorf("opencode session list: %w", err)
	}
	defer resp.Body.Close()
	var sessions []struct {
		ID        string `json:"id"`
		Directory string `json:"directory"`
		Time      struct {
			Created int64 `json:"created"`
			Updated int64 `json:"updated"`
		} `json:"time"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
		return nil, fmt.Errorf("opencode session list: %w", err)
	}

	u := &Usage{
		From: start.Format("2006-01-02"),
		To:   now.Format("2006-01-02"),
	}
	byDay := map[string]*DayUsage{}
	byModel := map[string]*ModelUsage{}
	byProvider := map[string]*ProviderUsage{}

	// A session last touched before the window can hold no message inside it,
	// so skipping it here saves the per-session message fetch entirely.
	var wanted []int
	for i, s := range sessions {
		last := s.Time.Updated
		if last == 0 {
			last = s.Time.Created
		}
		if last > 0 && time.UnixMilli(last).Before(start) {
			continue
		}
		wanted = append(wanted, i)
	}
	u.SessionsScanned = len(wanted)

	// Bounded fan-out: opencode is a local process, but a machine with hundreds
	// of threads shouldn't get hundreds of simultaneous requests either.
	type result struct {
		msgs []struct {
			Info ocMessageInfo `json:"info"`
		}
	}
	results := make([]result, len(wanted))
	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup
	for slot, idx := range wanted {
		wg.Add(1)
		go func(slot, idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			s := sessions[idx]
			endpoint := baseURL + "/session/" + url.PathEscape(s.ID) + "/message?directory=" + url.QueryEscape(s.Directory)
			r, err := client.Get(endpoint)
			if err != nil {
				return
			}
			defer r.Body.Close()
			if r.StatusCode != http.StatusOK {
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&results[slot].msgs)
		}(slot, idx)
	}
	wg.Wait()

	for _, res := range results {
		for _, m := range res.msgs {
			info := m.Info
			// user turns carry no accounting of their own — the tokens they
			// cost show up on the assistant message that answered them
			if info.Tokens.Total == 0 && info.Cost == 0 {
				continue
			}
			ts := info.Time.Completed
			if ts == 0 {
				ts = info.Time.Created
			}
			if ts == 0 {
				continue
			}
			at := time.UnixMilli(ts)
			if at.Before(start) {
				continue
			}
			tok := Tokens{
				Input:      info.Tokens.Input,
				Output:     info.Tokens.Output,
				Reasoning:  info.Tokens.Reasoning,
				CacheRead:  info.Tokens.Cache.Read,
				CacheWrite: info.Tokens.Cache.Write,
				Total:      info.Tokens.Total,
			}
			// opencode's own total is authoritative where it's set; derive one
			// only when it isn't, so a client's totals always add up
			if tok.Total == 0 {
				tok.Total = tok.Input + tok.Output + tok.Reasoning + tok.CacheRead + tok.CacheWrite
			}

			date := at.Format("2006-01-02")
			day := byDay[date]
			if day == nil {
				day = &DayUsage{Date: date}
				byDay[date] = day
			}
			day.Tokens.add(tok)
			day.Cost += info.Cost
			day.Messages++

			key := info.ProviderID + "/" + info.ModelID
			mdl := byModel[key]
			if mdl == nil {
				mdl = &ModelUsage{Key: key, Provider: info.ProviderID, Model: info.ModelID}
				byModel[key] = mdl
			}
			mdl.Tokens.add(tok)
			mdl.Cost += info.Cost
			mdl.Messages++

			prov := byProvider[info.ProviderID]
			if prov == nil {
				prov = &ProviderUsage{Provider: info.ProviderID}
				byProvider[info.ProviderID] = prov
			}
			prov.Tokens.add(tok)
			prov.Cost += info.Cost
			prov.Messages++

			u.Tokens.add(tok)
			u.Cost += info.Cost
			u.Messages++
			if info.Cost == 0 {
				day.UnpricedMessage++
				u.UnpricedMessages++
			}
		}
	}

	// oldest first, gaps filled — the axis belongs to the window, not the data
	for d := start; !d.After(now); d = d.AddDate(0, 0, 1) {
		date := d.Format("2006-01-02")
		if day := byDay[date]; day != nil {
			u.Days = append(u.Days, *day)
			continue
		}
		u.Days = append(u.Days, DayUsage{Date: date})
	}

	// model count per provider, so a provider row can say "3 models" without
	// the client having to group the model list itself
	modelsPer := map[string]int{}
	for _, m := range byModel {
		modelsPer[m.Provider]++
	}
	u.Providers = make([]ProviderUsage, 0, len(byProvider))
	for _, p := range byProvider {
		p.Models = modelsPer[p.Provider]
		u.Providers = append(u.Providers, *p)
	}
	sort.Slice(u.Providers, func(i, j int) bool {
		if u.Providers[i].Tokens.Total != u.Providers[j].Tokens.Total {
			return u.Providers[i].Tokens.Total > u.Providers[j].Tokens.Total
		}
		return u.Providers[i].Provider < u.Providers[j].Provider
	})

	u.Models = make([]ModelUsage, 0, len(byModel))
	for _, m := range byModel {
		u.Models = append(u.Models, *m)
	}
	sort.Slice(u.Models, func(i, j int) bool {
		if u.Models[i].Tokens.Total != u.Models[j].Tokens.Total {
			return u.Models[i].Tokens.Total > u.Models[j].Tokens.Total
		}
		return u.Models[i].Key < u.Models[j].Key
	})
	return u, nil
}
