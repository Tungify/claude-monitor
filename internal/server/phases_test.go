package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"claude-monitor/internal/api"
)

func postAssign(t *testing.T, s *Server, body any) *httptest.ResponseRecorder {
	t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/phases/assign", bytes.NewReader(buf))
	s.handleAssignPhases(rec, req)
	return rec
}

func TestAssignPhases_NoSnapshot(t *testing.T) {
	s := newTestServer(t)
	rec := postAssign(t, s, AssignPhasesRequest{Count: 2})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d want 503 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestAssignPhases_BadCount(t *testing.T) {
	s := newTestServer(t)
	for _, c := range []int{0, -1} {
		rec := postAssign(t, s, AssignPhasesRequest{Count: c})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("count=%d: got %d want 400", c, rec.Code)
		}
	}
}

func TestAssignPhases_PicksLowestUtilFirst(t *testing.T) {
	s := newTestServer(t)
	s.snap = &Snapshot{
		Accounts: []AccountState{
			{Name: "high", ConfigDir: "/d/high", FiveHour: &api.Window{Utilization: 0.9}},
			{Name: "low", ConfigDir: "/d/low", FiveHour: &api.Window{Utilization: 0.1}},
			{Name: "mid", ConfigDir: "/d/mid", FiveHour: &api.Window{Utilization: 0.5}},
		},
		FetchedAt: time.Now().UTC(),
	}
	rec := postAssign(t, s, AssignPhasesRequest{Count: 3})
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var resp AssignPhasesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Assignments) != 3 {
		t.Fatalf("assignments: got %d want 3", len(resp.Assignments))
	}
	want := []string{"low", "mid", "high"}
	for i, a := range resp.Assignments {
		if a.AccountName != want[i] {
			t.Errorf("position %d: got %s want %s", i, a.AccountName, want[i])
		}
	}
}

func TestAssignPhases_RoundRobinsWhenCountExceedsPool(t *testing.T) {
	s := newTestServer(t)
	s.snap = &Snapshot{
		Accounts: []AccountState{
			{Name: "a", ConfigDir: "/d/a", FiveHour: &api.Window{Utilization: 0.1}},
			{Name: "b", ConfigDir: "/d/b", FiveHour: &api.Window{Utilization: 0.2}},
		},
		FetchedAt: time.Now().UTC(),
	}
	rec := postAssign(t, s, AssignPhasesRequest{Count: 5})
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d (body: %s)", rec.Code, rec.Body.String())
	}
	var resp AssignPhasesResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Assignments) != 5 {
		t.Fatalf("assignments: got %d want 5", len(resp.Assignments))
	}
	want := []string{"a", "b", "a", "b", "a"}
	for i, a := range resp.Assignments {
		if a.AccountName != want[i] {
			t.Errorf("position %d: got %s want %s", i, a.AccountName, want[i])
		}
	}
}

func TestAssignPhases_SkipsKickedOrErrored(t *testing.T) {
	s := newTestServer(t)
	s.snap = &Snapshot{
		Accounts: []AccountState{
			{Name: "kicked", ConfigDir: "/d/k", Kicked: true, FiveHour: &api.Window{Utilization: 0.0}},
			{Name: "errored", ConfigDir: "/d/e", Error: "timeout", FiveHour: &api.Window{Utilization: 0.0}},
			{Name: "no-data", ConfigDir: "/d/n"},
			{Name: "ok", ConfigDir: "/d/o", FiveHour: &api.Window{Utilization: 0.7}},
		},
		FetchedAt: time.Now().UTC(),
	}
	rec := postAssign(t, s, AssignPhasesRequest{Count: 1})
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d (body: %s)", rec.Code, rec.Body.String())
	}
	var resp AssignPhasesResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Assignments) != 1 || resp.Assignments[0].AccountName != "ok" {
		t.Fatalf("assignments: got %+v want [ok]", resp.Assignments)
	}
}

func TestAssignPhases_ExcludesByConfigDir(t *testing.T) {
	s := newTestServer(t)
	s.snap = &Snapshot{
		Accounts: []AccountState{
			{Name: "a", ConfigDir: "/d/a", FiveHour: &api.Window{Utilization: 0.1}},
			{Name: "b", ConfigDir: "/d/b", FiveHour: &api.Window{Utilization: 0.2}},
		},
		FetchedAt: time.Now().UTC(),
	}
	rec := postAssign(t, s, AssignPhasesRequest{Count: 1, Exclude: []string{"/d/a"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d", rec.Code)
	}
	var resp AssignPhasesResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Assignments) != 1 || resp.Assignments[0].AccountName != "b" {
		t.Fatalf("got %+v want [b]", resp.Assignments)
	}
}

func TestAssignPhases_NoEligibleAccounts(t *testing.T) {
	s := newTestServer(t)
	s.snap = &Snapshot{
		Accounts: []AccountState{
			{Name: "kicked", ConfigDir: "/d/k", Kicked: true},
		},
		FetchedAt: time.Now().UTC(),
	}
	rec := postAssign(t, s, AssignPhasesRequest{Count: 1})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status: got %d want 422 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestAssignPhases_InvalidJSON(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/phases/assign", bytes.NewReader([]byte("nope")))
	s.handleAssignPhases(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: got %d want 400", rec.Code)
	}
}
