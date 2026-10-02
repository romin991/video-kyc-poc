package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/romin991/video-kyc-poc/apps/go-api/internal/session"
)

type checklistBody struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Checked bool   `json:"checked"`
}

type promptBody struct {
	Field  string `json:"field"`
	Prompt string `json:"prompt"`
	SentAt string `json:"sentAt"`
}

type answerBody struct {
	Field      string `json:"field"`
	Prompt     string `json:"prompt"`
	Answer     string `json:"answer"`
	AnsweredAt string `json:"answeredAt"`
}

type digitBody struct {
	Digits string `json:"digits"`
	Prompt string `json:"prompt"`
	SentAt string `json:"sentAt"`
}

type captureBody struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	ContentType string `json:"contentType"`
	CreatedAt   string `json:"createdAt"`
	CapturedAt  string `json:"capturedAt"`
}

func (s *Server) patch(w http.ResponseWriter, r *http.Request) {
	raw, err := readJSON(w, r, 32*1024)
	if err != nil {
		writeReadError(w, err, false)
		return
	}
	patch, message := parsePatch(raw)
	if message != "" {
		writeError(w, http.StatusBadRequest, "bad_request", message)
		return
	}
	item, code, message := s.store.Update(r.PathValue("id"), patch, s.now())
	if writeStoreError(w, code, message) {
		return
	}
	writeJSON(w, http.StatusOK, s.sessionJSON(r, item))
}

func (s *Server) reply(w http.ResponseWriter, r *http.Request) {
	item, ok := s.store.GetByToken(r.PathValue("token"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "Join link not found")
		return
	}
	raw, err := readJSON(w, r, 32*1024)
	if err != nil {
		writeReadError(w, err, false)
		return
	}
	parsed, message := parseReply(raw)
	if message != "" {
		writeError(w, http.StatusBadRequest, "bad_request", message)
		return
	}
	updated, code, message := s.store.RecordReply(item.ID, parsed, s.now())
	if writeStoreError(w, code, message) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"maPrompt":       promptJSON(updated.MaPrompt),
		"digitChallenge": digitJSON(updated.DigitChallenge),
	})
}

func (s *Server) createCapture(w http.ResponseWriter, r *http.Request) {
	raw, err := readJSON(w, r, 8<<20)
	if err != nil {
		writeReadError(w, err, true)
		return
	}
	obj, message := parseObject(raw)
	if message != "" {
		writeError(w, http.StatusBadRequest, "bad_request", message)
		return
	}
	imageRaw, ok := obj["image"]
	var imageText string
	if !ok || json.Unmarshal(imageRaw, &imageText) != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "image is required (file field or base64/data URL)")
		return
	}
	contentType, blob, status, message := decodeImage(imageText)
	if status != http.StatusOK {
		code := "bad_request"
		if status == http.StatusRequestEntityTooLarge {
			code = "payload_too_large"
		}
		writeError(w, status, code, message)
		return
	}
	kind, capturedAt, message := parseCaptureMeta(obj, s.now())
	if message != "" {
		writeError(w, http.StatusBadRequest, "bad_request", message)
		return
	}
	_, capture, code, message := s.store.AddCapture(r.PathValue("id"), kind, contentType, blob, capturedAt, s.now())
	if writeStoreError(w, code, message) {
		return
	}
	writeJSON(w, http.StatusCreated, captureJSON(r, r.PathValue("id"), capture))
}

func (s *Server) getCapture(w http.ResponseWriter, r *http.Request) {
	contentType, blob, ok := s.store.CaptureBytes(r.PathValue("id"), r.PathValue("captureId"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "Capture not found")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(blob)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(blob)
}

func writeStoreError(w http.ResponseWriter, code session.AcceptError, message string) bool {
	switch code {
	case "":
		return false
	case session.ErrNotFound:
		writeError(w, http.StatusNotFound, "not_found", message)
	case session.ErrConflict:
		writeError(w, http.StatusConflict, "conflict", message)
	case session.ErrLimit:
		writeError(w, http.StatusConflict, "limit", message)
	default:
		writeError(w, http.StatusBadRequest, "bad_request", message)
	}
	return true
}

func readJSON(w http.ResponseWriter, r *http.Request, limit int64) (json.RawMessage, error) {
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	var raw json.RawMessage
	err := decoder.Decode(&raw)
	return raw, err
}

func writeReadError(w http.ResponseWriter, err error, image bool) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		if image {
			writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Image must be 4 MB or smaller")
			return
		}
		writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Request body is too large")
		return
	}
	if errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "bad_request", "Body must be a JSON object")
		return
	}
	writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON body")
}

func checklistJSON(items []session.ChecklistItem) []checklistBody {
	out := make([]checklistBody, 0, len(items))
	for _, item := range items {
		out = append(out, checklistBody{ID: item.ID, Label: item.Label, Checked: item.Checked})
	}
	return out
}

func answersJSON(items []session.MaAnswer) []answerBody {
	out := make([]answerBody, 0, len(items))
	for _, item := range items {
		out = append(out, answerBody{
			Field:      string(item.Field),
			Prompt:     item.Prompt,
			Answer:     item.Answer,
			AnsweredAt: formatTime(item.AnsweredAt),
		})
	}
	return out
}

func promptJSON(prompt *session.MaPrompt) *promptBody {
	if prompt == nil {
		return nil
	}
	return &promptBody{
		Field:  string(prompt.Field),
		Prompt: prompt.Prompt,
		SentAt: formatTime(prompt.SentAt),
	}
}

func digitJSON(challenge *session.DigitChallenge) *digitBody {
	if challenge == nil {
		return nil
	}
	return &digitBody{
		Digits: challenge.Digits,
		Prompt: challenge.Prompt,
		SentAt: formatTime(challenge.SentAt),
	}
}

func kindString(kind *session.CaptureKind) *string {
	if kind == nil {
		return nil
	}
	value := string(*kind)
	return &value
}

func timePtr(value time.Time) *string {
	if value.IsZero() {
		return nil
	}
	formatted := formatTime(value)
	return &formatted
}

func captureListJSON(r *http.Request, item *session.Session) []captureBody {
	out := make([]captureBody, 0, len(item.Captures))
	for _, capture := range item.Captures {
		out = append(out, captureJSON(r, item.ID, capture))
	}
	return out
}

func captureJSON(r *http.Request, sessionID string, capture session.Capture) captureBody {
	path := "/sessions/" + sessionID + "/captures/" + capture.ID
	return captureBody{
		ID:          capture.ID,
		URL:         requestBase(r) + path,
		Path:        path,
		Kind:        string(capture.Kind),
		ContentType: capture.ContentType,
		CreatedAt:   formatTime(capture.CreatedAt),
		CapturedAt:  formatTime(capture.CapturedAt),
	}
}

func requestBase(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto == "http" || proto == "https" {
		scheme = proto
	}
	return scheme + "://" + r.Host
}
