package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleMcpConnectionsList_Empty(t *testing.T) {
	setupHomeDir(t)
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	s.handleMcpConnectionsList(rec, httptest.NewRequest(http.MethodGet, "/api/mcp/connections", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Connections []map[string]any `json:"connections"`
		UVX         map[string]any   `json:"uvx"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(body.Connections) != 0 {
		t.Fatalf("expected empty, got %v", body.Connections)
	}
	if body.UVX == nil {
		t.Fatalf("missing uvx block: %s", rec.Body.String())
	}
}

func TestHandleMcpConnectionsCreate_PostgresAndList(t *testing.T) {
	setupHomeDir(t)
	s := newTestServer(t)

	create := httptest.NewRecorder()
	s.handleMcpConnectionsCreate(create, httptest.NewRequest(
		http.MethodPost, "/api/mcp/connections",
		bytes.NewReader([]byte(`{"name":"warehouse","driver":"postgres","uri":"postgres://u:secret@h/db"}`)),
	))
	if create.Code != http.StatusOK {
		t.Fatalf("create status: %d body=%s", create.Code, create.Body.String())
	}

	list := httptest.NewRecorder()
	s.handleMcpConnectionsList(list, httptest.NewRequest(http.MethodGet, "/api/mcp/connections", nil))
	if list.Code != http.StatusOK {
		t.Fatalf("list status: %d", list.Code)
	}
	var body struct {
		Connections []map[string]any `json:"connections"`
	}
	_ = json.Unmarshal(list.Body.Bytes(), &body)
	if len(body.Connections) != 1 {
		t.Fatalf("expected 1 connection, got %v", body.Connections)
	}
	got := body.Connections[0]
	if got["name"] != "warehouse" {
		t.Fatalf("name: %v", got["name"])
	}
	uri, _ := got["uri"].(string)
	if uri == "" {
		t.Fatalf("expected redacted uri, got empty")
	}
	if bytes.Contains([]byte(uri), []byte("secret")) {
		t.Fatalf("redacted uri leaked password: %q", uri)
	}
}

func TestHandleMcpConnectionsCreate_InvalidName(t *testing.T) {
	setupHomeDir(t)
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	s.handleMcpConnectionsCreate(rec, httptest.NewRequest(
		http.MethodPost, "/api/mcp/connections",
		bytes.NewReader([]byte(`{"name":"BAD-NAME","driver":"postgres","uri":"postgres://h"}`)),
	))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleMcpConnectionsUpdate_NotFound(t *testing.T) {
	setupHomeDir(t)
	s := newTestServer(t)
	req := httptest.NewRequest(
		http.MethodPut, "/api/mcp/connections/missing",
		bytes.NewReader([]byte(`{"name":"x","driver":"postgres","uri":"postgres://h"}`)),
	)
	req.SetPathValue("id", "missing")
	rec := httptest.NewRecorder()
	s.handleMcpConnectionsUpdate(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleMcpConnectionsDelete_Roundtrip(t *testing.T) {
	setupHomeDir(t)
	s := newTestServer(t)

	createRec := httptest.NewRecorder()
	s.handleMcpConnectionsCreate(createRec, httptest.NewRequest(
		http.MethodPost, "/api/mcp/connections",
		bytes.NewReader([]byte(`{"name":"x","driver":"postgres","uri":"postgres://h/d"}`)),
	))
	var created struct {
		Connection struct {
			ID string `json:"id"`
		} `json:"connection"`
	}
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Connection.ID == "" {
		t.Fatalf("missing id: %s", createRec.Body.String())
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/api/mcp/connections/"+created.Connection.ID, nil)
	delReq.SetPathValue("id", created.Connection.ID)
	delRec := httptest.NewRecorder()
	s.handleMcpConnectionsDelete(delRec, delReq)
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete: %d body=%s", delRec.Code, delRec.Body.String())
	}

	// 404 on second delete — already gone.
	delReq2 := httptest.NewRequest(http.MethodDelete, "/api/mcp/connections/"+created.Connection.ID, nil)
	delReq2.SetPathValue("id", created.Connection.ID)
	delRec2 := httptest.NewRecorder()
	s.handleMcpConnectionsDelete(delRec2, delReq2)
	if delRec2.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on second delete, got %d", delRec2.Code)
	}
}

// setupHomeDir mirrors the helper from the legacy mcp_postgres_test.go.
// Re-introduced here because the original file was deleted with the
// rest of the single-tier code.
func setupHomeDir(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
}
