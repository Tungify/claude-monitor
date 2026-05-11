package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"

	"claude-monitor/internal/config"
)

// SwapConfigView is the JSON shape exposed at /api/swap-config — a
// curated subset of config.Config containing just the auto-swap knobs.
// LAN/Public/keychain bits stay in their own endpoints so the UI can
// fetch + update each surface independently.
type SwapConfigView struct {
	AutoSwap         bool      `json:"auto_swap"`
	AutoKick         bool      `json:"auto_kick"`
	SwapThresholds  []float64 `json:"swap_thresholds"`
	PickOrder        string    `json:"pick_order"`
	RebalanceOnReset bool      `json:"rebalance_on_reset"`
}

// SwapConfigUpdate carries the writable fields. Fields are pointers so
// PATCH-style partial updates land cleanly: omitted fields preserve the
// existing value, fields set to their zero (e.g. AutoSwap=false) take
// effect because the pointer is non-nil.
type SwapConfigUpdate struct {
	AutoSwap         *bool      `json:"auto_swap,omitempty"`
	AutoKick         *bool      `json:"auto_kick,omitempty"`
	SwapThresholds   *[]float64 `json:"swap_thresholds,omitempty"`
	PickOrder        *string    `json:"pick_order,omitempty"`
	RebalanceOnReset *bool      `json:"rebalance_on_reset,omitempty"`
}

func (s *Server) handleSwapConfigGet(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	cfg := s.cfg
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, swapConfigViewFrom(cfg))
}

// handleSwapConfigUpdate applies a partial update to the auto-swap
// config, persists it to ~/.claude-monitor/config.json, and returns the
// new effective view. Validation rejects out-of-range thresholds and
// invalid pickOrder values so the user gets immediate feedback rather
// than a silent clamp during sanitize.
func (s *Server) handleSwapConfigUpdate(w http.ResponseWriter, r *http.Request) {
	var body SwapConfigUpdate
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid json: " + err.Error(),
		})
		return
	}

	if body.PickOrder != nil {
		v := *body.PickOrder
		if v != config.PickOrderLowest && v != config.PickOrderHighest {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf(
					"pick_order must be %q or %q",
					config.PickOrderLowest, config.PickOrderHighest,
				),
			})
			return
		}
	}
	if body.SwapThresholds != nil {
		if len(*body.SwapThresholds) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "swap_thresholds must have at least one value",
			})
			return
		}
		for _, v := range *body.SwapThresholds {
			if v < 0 || v > 100 {
				writeJSON(w, http.StatusBadRequest, map[string]string{
					"error": fmt.Sprintf("swap_thresholds value out of range 0-100: %v", v),
				})
				return
			}
		}
	}

	// Lock + mutate + clone before releasing so a concurrent reader
	// doesn't observe a half-updated config. config.Save runs after
	// release because writing to disk shouldn't hold the server lock.
	s.mu.Lock()
	if body.AutoSwap != nil {
		s.cfg.AutoSwap = *body.AutoSwap
	}
	if body.AutoKick != nil {
		s.cfg.AutoKick = *body.AutoKick
	}
	if body.SwapThresholds != nil {
		// Sanitize inline so the on-disk file always reflects the
		// canonical form (sorted, dedup'd, clamped). Mirrors what
		// config.Load does on read so we stay round-trip stable.
		s.cfg.SwapThresholds = config.SanitizeThresholds(*body.SwapThresholds)
	}
	if body.PickOrder != nil {
		s.cfg.PickOrder = *body.PickOrder
	}
	if body.RebalanceOnReset != nil {
		s.cfg.RebalanceOnReset = *body.RebalanceOnReset
	}
	saved := s.cfg
	s.mu.Unlock()

	if err := config.Save(saved); err != nil {
		// Surface the persistence failure rather than pretending it
		// worked — the in-memory state already took effect, but the
		// user expects "save" to mean "survives restart". A 500 lets
		// the UI roll back its optimistic state.
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "persist failed: " + err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, swapConfigViewFrom(saved))
}

func swapConfigViewFrom(cfg config.Config) SwapConfigView {
	// Copy the slice so callers can't mutate s.cfg through the response
	// shape if they ever embed this struct.
	thresholds := append([]float64(nil), cfg.SwapThresholds...)
	sort.Float64s(thresholds)
	return SwapConfigView{
		AutoSwap:         cfg.AutoSwap,
		AutoKick:         cfg.AutoKick,
		SwapThresholds:   thresholds,
		PickOrder:        cfg.PickOrder,
		RebalanceOnReset: cfg.RebalanceOnReset,
	}
}
