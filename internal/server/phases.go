package server

import (
	"encoding/json"
	"net/http"
	"sort"
)

// PhaseAssignment is one account picked for a phase. The web side
// pairs these with phase slugs in the order they were requested. We
// don't bind a slug here so the caller can decide how to fan out — the
// daemon's job is just to rank accounts by quota headroom.
type PhaseAssignment struct {
	ConfigDir            string  `json:"config_dir"`
	AccountName          string  `json:"account_name"`
	AccountUUID          string  `json:"account_uuid,omitempty"`
	FiveHourUtilization  float64 `json:"five_hour_utilization"`
	WeeklyUtilization    float64 `json:"weekly_utilization"`
}

type AssignPhasesRequest struct {
	// How many accounts to pick. If greater than the eligible pool the
	// daemon round-robins picks so callers always receive Count entries.
	Count int `json:"count"`
	// Optional config dirs to skip — e.g. accounts the caller already
	// reserved for other phases in the same plan and wants spread out.
	Exclude []string `json:"exclude,omitempty"`
}

type AssignPhasesResponse struct {
	Assignments []PhaseAssignment `json:"assignments"`
}

func (s *Server) handleAssignPhases(w http.ResponseWriter, r *http.Request) {
	var req AssignPhasesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	if req.Count <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "count must be > 0"})
		return
	}

	s.mu.RLock()
	snap := s.snap
	s.mu.RUnlock()
	if snap == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no account snapshot yet"})
		return
	}

	excluded := make(map[string]bool, len(req.Exclude))
	for _, d := range req.Exclude {
		excluded[d] = true
	}

	// Eligible: has FiveHour data, not kicked, no error, not excluded.
	// We treat missing FiveHour as "we don't know — skip" rather than
	// gambling that the account works; M5.1 prefers fewer parallel
	// workers over a stalled phase.
	eligible := make([]PhaseAssignment, 0, len(snap.Accounts))
	for _, a := range snap.Accounts {
		if a.Kicked || a.Error != "" || excluded[a.ConfigDir] {
			continue
		}
		if a.FiveHour == nil {
			continue
		}
		weeklyUtil := 0.0
		if a.Weekly != nil {
			weeklyUtil = a.Weekly.Utilization
		}
		eligible = append(eligible, PhaseAssignment{
			ConfigDir:           a.ConfigDir,
			AccountName:         a.Name,
			AccountUUID:         a.AccountUUID,
			FiveHourUtilization: a.FiveHour.Utilization,
			WeeklyUtilization:   weeklyUtil,
		})
	}
	if len(eligible) == 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"error": "no eligible accounts (all kicked, errored, or missing usage data)",
		})
		return
	}

	// Ascending by 5h utilization, weekly as tiebreaker. The lowest-
	// loaded accounts get used first; if parallelism > pool size we
	// wrap so callers always receive Count entries.
	sort.SliceStable(eligible, func(i, j int) bool {
		if eligible[i].FiveHourUtilization != eligible[j].FiveHourUtilization {
			return eligible[i].FiveHourUtilization < eligible[j].FiveHourUtilization
		}
		return eligible[i].WeeklyUtilization < eligible[j].WeeklyUtilization
	})

	assignments := make([]PhaseAssignment, 0, req.Count)
	for i := 0; i < req.Count; i++ {
		assignments = append(assignments, eligible[i%len(eligible)])
	}

	writeJSON(w, http.StatusOK, AssignPhasesResponse{Assignments: assignments})
}
