// Package mediahttp exposes the LiveKit mint over HTTP until session
// accept and join call livekit.Minter themselves.
//
//	POST /media/tokens   {"sessionId","role":"agent"|"customer"}
//	GET  /health
//
// Eng should prefer Minter.ForAccept and Minter.ForJoin inside the session
// handlers. This route is the stand-in the Next call shells use when those
// handlers are not mounted yet. Do not leave it public without the session
// checks those handlers will add.
package mediahttp

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/romin991/video-kyc-poc/services/vkyc-api/internal/livekit"
)

type tokenRequest struct {
	SessionID string `json:"sessionId"`
	Role      string `json:"role"`
}

// Register mounts the media routes on mux.
func Register(mux *http.ServeMux, minter *livekit.Minter, allowedOrigins []string) {
	guard := cors(allowedOrigins)
	mux.Handle("GET /health", guard(http.HandlerFunc(health)))
	mux.Handle("POST /media/tokens", guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mint(w, r, minter)
	})))
	mux.Handle("OPTIONS /media/tokens", guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})))
	mux.Handle("OPTIONS /health", guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})))
}

func health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "vkyc-api-go"})
}

func mint(w http.ResponseWriter, r *http.Request, minter *livekit.Minter) {
	var body tokenRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	media, err := minter.ForRole(strings.TrimSpace(body.Role), strings.TrimSpace(body.SessionID))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, media)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func cors(allowed []string) func(http.Handler) http.Handler {
	exact := map[string]struct{}{}
	for _, origin := range allowed {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			exact[origin] = struct{}{}
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if _, ok := exact[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// DefaultOrigins are the Next dev servers. CORS_ORIGINS is appended by main.
func DefaultOrigins() []string {
	return []string{
		"http://127.0.0.1:3100",
		"http://localhost:3100",
		"http://127.0.0.1:3101",
		"http://localhost:3101",
	}
}
