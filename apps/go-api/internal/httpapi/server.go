// Package httpapi is the session shell: create, join-by-token, claim, accept,
// and end, plus manual authentication, digit prompts, checklist ticks, and
// still captures. Recording and after-call disposition stay on the Express
// reference.
package httpapi

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/romin991/video-kyc-poc/apps/go-api/internal/config"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/livekit"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/session"
)

// Server is the session HTTP API.
type Server struct {
	store          *session.Store
	customerOrigin string
	corsOrigins    map[string]struct{}
	livekitURL     string
	minter         livekit.Minter
	now            func() time.Time
}

// New builds the handler. minter may be nil when LiveKit is unconfigured;
// a nil minter still returns lk-stub tokens.
func New(store *session.Store, cfg config.Config, minter livekit.Minter) http.Handler {
	if store == nil {
		store = session.NewStore()
	}
	if minter == nil {
		minter = livekit.New("", "")
	}
	allowed := make(map[string]struct{}, len(cfg.CORSOrigins))
	for _, origin := range cfg.CORSOrigins {
		allowed[origin] = struct{}{}
	}
	srv := &Server{
		store:          store,
		customerOrigin: strings.TrimRight(cfg.CustomerOrigin, "/"),
		corsOrigins:    allowed,
		livekitURL:     cfg.LiveKitURL,
		minter:         minter,
		now:            time.Now,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", srv.health)
	mux.HandleFunc("POST /sessions", srv.create)
	mux.HandleFunc("GET /sessions", srv.list)
	mux.HandleFunc("POST /sessions/claim", srv.claim)
	mux.HandleFunc("GET /sessions/{id}", srv.get)
	mux.HandleFunc("PATCH /sessions/{id}", srv.patch)
	mux.HandleFunc("POST /sessions/{id}/accept", srv.accept)
	mux.HandleFunc("POST /sessions/{id}/end", srv.end)
	mux.HandleFunc("POST /sessions/{id}/captures", srv.createCapture)
	mux.HandleFunc("GET /sessions/{id}/captures/{captureId}", srv.getCapture)
	mux.HandleFunc("GET /join/{token}", srv.join)
	mux.HandleFunc("POST /join/{token}/replies", srv.reply)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "Route not found")
	})
	return srv.wrap(mux)
}

func (s *Server) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")
		if _, ok := s.corsOrigins[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Demo-Agent")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		rec := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d", r.Method, r.URL.RequestURI(), rec.status)
	})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "vkyc-api",
		"stack":   "go",
	})
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	if err := discardJSON(w, r); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body")
		return
	}
	created := s.store.Create(demoAgent(r), s.now())
	writeJSON(w, http.StatusCreated, s.sessionJSON(r, created))
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("status")
	var status session.Status
	if raw != "" {
		switch session.Status(raw) {
		case session.StatusWaiting, session.StatusInCall, session.StatusEnded:
			status = session.Status(raw)
		default:
			writeError(w, http.StatusBadRequest, "bad_request", "status must be waiting, in_call, or ended")
			return
		}
	}
	sessions := s.store.List(status)
	body := make([]sessionBody, 0, len(sessions))
	for _, item := range sessions {
		body = append(body, s.sessionJSON(r, item))
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": body})
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	item, ok := s.store.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "Session not found")
		return
	}
	writeJSON(w, http.StatusOK, s.sessionJSON(r, item))
}

func (s *Server) claim(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.ClaimNext(demoAgent(r), s.now())
	if err == session.ErrEmpty {
		writeError(w, http.StatusConflict, "conflict", "No session is waiting in the queue")
		return
	}
	if err == session.ErrNotFound {
		writeError(w, http.StatusNotFound, "not_found", "Session not found")
		return
	}
	if err != "" {
		status := "unavailable"
		if item != nil {
			status = string(item.Status)
		}
		writeError(w, http.StatusConflict, "conflict", "Session is "+status+" and cannot be claimed")
		return
	}
	writeJSON(w, http.StatusOK, s.claimedJSON(item))
}

func (s *Server) accept(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.Accept(r.PathValue("id"), demoAgent(r), s.now())
	if err == session.ErrNotFound {
		writeError(w, http.StatusNotFound, "not_found", "Session not found")
		return
	}
	if err != "" {
		status := "unavailable"
		if item != nil {
			status = string(item.Status)
		}
		writeError(w, http.StatusConflict, "conflict", "Session is "+status+" and cannot be accepted")
		return
	}
	writeJSON(w, http.StatusOK, s.claimedJSON(item))
}

func (s *Server) end(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.End(r.PathValue("id"), s.now())
	if err != "" {
		writeError(w, http.StatusNotFound, "not_found", "Session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status":    "ended",
		"sessionId": item.ID,
	})
}

func (s *Server) join(w http.ResponseWriter, r *http.Request) {
	item, ok := s.store.GetByToken(r.PathValue("token"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "Join link not found")
		return
	}
	writeJSON(w, http.StatusOK, joinBody{
		SessionID:      item.ID,
		RoomName:       item.RoomName,
		CustomerToken:  s.minter.ParticipantToken("customer", item.RoomName),
		Status:         string(item.Status),
		QueuePosition:  positionPtr(s.store.QueuePosition(item.ID)),
		LiveKitURL:     s.livekitURL,
		CaptureGuide:   kindString(item.CaptureGuide),
		MaPrompt:       promptJSON(item.MaPrompt),
		DigitChallenge: digitJSON(item.DigitChallenge),
	})
}

func (s *Server) sessionJSON(r *http.Request, item *session.Session) sessionBody {
	body := sessionBody{
		ID:               item.ID,
		JoinURL:          s.customerOrigin + "/join/" + item.JoinToken,
		JoinToken:        item.JoinToken,
		Status:           string(item.Status),
		RoomName:         item.RoomName,
		CreatedAt:        formatTime(item.CreatedAt),
		CreatedBy:        item.CreatedBy,
		ClaimedBy:        nilIfEmpty(item.ClaimedBy),
		QueuePosition:    positionPtr(s.store.QueuePosition(item.ID)),
		LiveKitURL:       s.livekitURL,
		Checklist:        checklistJSON(item.Checklist),
		CaptureGuide:     kindString(item.CaptureGuide),
		MaPrompt:         promptJSON(item.MaPrompt),
		MaAnswers:        answersJSON(item.MaAnswers),
		DigitChallenge:   digitJSON(item.DigitChallenge),
		DigitResponse:    item.DigitResponse,
		DigitRespondedAt: timePtr(item.DigitRespondedAt),
		MaMatch:          item.MaMatch,
		DigitMatch:       item.DigitMatch,
		Captures:         captureListJSON(r, item),
	}
	if !item.AcceptedAt.IsZero() {
		value := formatTime(item.AcceptedAt)
		body.AcceptedAt = &value
	}
	if !item.EndedAt.IsZero() {
		value := formatTime(item.EndedAt)
		body.EndedAt = &value
	}
	return body
}

func (s *Server) claimedJSON(item *session.Session) claimBody {
	return claimBody{
		SessionID:  item.ID,
		RoomName:   item.RoomName,
		AgentToken: s.minter.ParticipantToken("agent", item.RoomName),
		JoinURL:    s.customerOrigin + "/join/" + item.JoinToken,
		Status:     "in_call",
		ClaimedBy:  nilIfEmpty(item.ClaimedBy),
		LiveKitURL: s.livekitURL,
	}
}

type sessionBody struct {
	ID               string          `json:"id"`
	JoinURL          string          `json:"joinUrl"`
	JoinToken        string          `json:"joinToken"`
	Status           string          `json:"status"`
	RoomName         string          `json:"roomName"`
	CreatedAt        string          `json:"createdAt"`
	CreatedBy        string          `json:"createdBy"`
	ClaimedBy        *string         `json:"claimedBy"`
	QueuePosition    *int            `json:"queuePosition"`
	AcceptedAt       *string         `json:"acceptedAt,omitempty"`
	EndedAt          *string         `json:"endedAt,omitempty"`
	LiveKitURL       string          `json:"livekitUrl"`
	Checklist        []checklistBody `json:"checklist"`
	CaptureGuide     *string         `json:"captureGuide"`
	MaPrompt         *promptBody     `json:"maPrompt"`
	MaAnswers        []answerBody    `json:"maAnswers"`
	DigitChallenge   *digitBody      `json:"digitChallenge"`
	DigitResponse    *string         `json:"digitResponse"`
	DigitRespondedAt *string         `json:"digitRespondedAt"`
	MaMatch          *bool           `json:"maMatch"`
	DigitMatch       *bool           `json:"digitMatch"`
	Captures         []captureBody   `json:"captures"`
}

type claimBody struct {
	SessionID  string  `json:"sessionId"`
	RoomName   string  `json:"roomName"`
	AgentToken string  `json:"agentToken"`
	JoinURL    string  `json:"joinUrl"`
	Status     string  `json:"status"`
	ClaimedBy  *string `json:"claimedBy"`
	LiveKitURL string  `json:"livekitUrl"`
}

type joinBody struct {
	SessionID      string      `json:"sessionId"`
	RoomName       string      `json:"roomName"`
	CustomerToken  string      `json:"customerToken"`
	Status         string      `json:"status"`
	QueuePosition  *int        `json:"queuePosition"`
	LiveKitURL     string      `json:"livekitUrl"`
	CaptureGuide   *string     `json:"captureGuide"`
	MaPrompt       *promptBody `json:"maPrompt"`
	DigitChallenge *digitBody  `json:"digitChallenge"`
}

func positionPtr(position int) *int {
	if position <= 0 {
		return nil
	}
	return &position
}

func nilIfEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func formatTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func demoAgent(r *http.Request) string {
	raw := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(r.Header.Get("X-Demo-Agent"), "\r", " "), "\n", " "))
	raw = strings.Join(strings.Fields(raw), " ")
	if len(raw) > 80 {
		raw = raw[:80]
	}
	if raw == "" {
		return "Demo agent"
	}
	return raw
}

// discardJSON accepts an empty body or one JSON value. The P0 create call
// does not read onboarding fields; those stay on the Express reference.
func discardJSON(w http.ResponseWriter, r *http.Request) error {
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(w, r.Body, 32*1024)
	dec := json.NewDecoder(r.Body)
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		if err == io.EOF {
			return nil
		}
		return err
	}
	return nil
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(body)
}

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(status int) {
	if w.wrote {
		return
	}
	w.status = status
	w.wrote = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}
