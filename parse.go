package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

// Usage holds the four token counters we care about per assistant turn.
type Usage struct {
	Input       int64
	Output      int64
	CacheCreate int64
	CacheRead   int64
}

func (u Usage) Total() int64 {
	return u.Input + u.Output + u.CacheCreate + u.CacheRead
}

// Record is one parsed assistant turn from a transcript .jsonl file.
type Record struct {
	Time  time.Time
	Model string
	Usage Usage
}

// rawLine matches the subset of the JSONL line shape we need.
type rawLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// fileCache stores the parsed records for a transcript file plus the
// byte offset and stat info we used. On the next refresh we only re-parse
// the bytes appended past Offset, which keeps live mode cheap even when
// a single account has hundreds of multi-MB transcripts.
type fileCache struct {
	Size    int64
	ModTime time.Time
	Offset  int64
	Records []Record
}

type Parser struct {
	mu    sync.Mutex
	cache map[string]*fileCache
}

func NewParser() *Parser {
	return &Parser{cache: make(map[string]*fileCache)}
}

// Parse returns all assistant-turn records for the given transcript file,
// using and updating the per-file cache.
func (p *Parser) Parse(path string) ([]Record, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	prev, hadPrev := p.cache[path]
	p.mu.Unlock()

	if hadPrev && prev.Size == st.Size() && prev.ModTime.Equal(st.ModTime()) {
		return prev.Records, nil
	}

	var startOffset int64
	var records []Record
	// Append-only fast path: file grew, nothing earlier rewritten.
	if hadPrev && st.Size() >= prev.Size && !st.ModTime().Before(prev.ModTime) {
		startOffset = prev.Offset
		records = append(records, prev.Records...)
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	if startOffset > 0 {
		if _, err := f.Seek(startOffset, io.SeekStart); err != nil {
			startOffset = 0
			records = records[:0]
			f.Seek(0, io.SeekStart)
		}
	}

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	consumed := startOffset
	for scanner.Scan() {
		line := scanner.Bytes()
		consumed += int64(len(line)) + 1 // +1 for the trimmed newline

		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var r rawLine
		if err := json.Unmarshal(line, &r); err != nil {
			continue
		}
		if r.Type != "assistant" || r.Message == nil || r.Message.Usage == nil {
			continue
		}
		t, _ := time.Parse(time.RFC3339Nano, r.Timestamp)
		records = append(records, Record{
			Time:  t,
			Model: r.Message.Model,
			Usage: Usage{
				Input:       r.Message.Usage.InputTokens,
				Output:      r.Message.Usage.OutputTokens,
				CacheCreate: r.Message.Usage.CacheCreationInputTokens,
				CacheRead:   r.Message.Usage.CacheReadInputTokens,
			},
		})
	}

	p.mu.Lock()
	p.cache[path] = &fileCache{
		Size:    st.Size(),
		ModTime: st.ModTime(),
		Offset:  consumed,
		Records: records,
	}
	p.mu.Unlock()
	return records, nil
}
