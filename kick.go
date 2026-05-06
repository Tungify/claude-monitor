package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	messagesEndpoint = "https://api.anthropic.com/v1/messages"
	kickModel        = "claude-haiku-4-5"
	kickSystem       = "You are Claude Code, Anthropic's official CLI for Claude."
)

// KickWindow sends a 1-token /v1/messages request using the OAuth bearer token.
// The point is to mark the account as "active" so the rolling 5h window starts
// counting from now — Anthropic only opens a new window when a message is sent
// after the previous reset_at, so we have to push something through.
func KickWindow(ctx context.Context, token string) error {
	body := map[string]any{
		"model":      kickModel,
		"max_tokens": 1,
		"system":     kickSystem,
		"messages": []map[string]string{
			{"role": "user", "content": "."},
		},
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, messagesEndpoint, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", oauthBeta)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", probeUA)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		preview := string(b)
		if len(preview) > 200 {
			preview = preview[:200] + "…"
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, preview)
	}
	io.Copy(io.Discard, resp.Body)
	return nil
}
