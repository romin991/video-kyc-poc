package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/romin991/video-kyc-poc/apps/go-api/internal/config"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/session"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/stub"
)

// StubSummary is the process log line for where disposition bodies go.
func StubSummary(cfg config.Config) string {
	return stub.New(cfg.CRMWebhookURL, cfg.DatalakeWebhookURL, cfg.DispositionLogPath).Describe()
}

func (s *Server) listStubs(w http.ResponseWriter, r *http.Request) {
	all := s.stubs.List()
	if all == nil {
		all = []json.RawMessage{}
	}
	sessionID := strings.TrimSpace(r.URL.Query().Get("sessionId"))
	if sessionID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"stubs": all})
		return
	}
	matched := make([]json.RawMessage, 0)
	for _, raw := range all {
		var peek struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(raw, &peek) == nil && peek.SessionID == sessionID {
			matched = append(matched, raw)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"stubs": matched})
}

func (s *Server) listCaptures(w http.ResponseWriter, r *http.Request) {
	item, ok := s.store.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "Session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"captures": captureListJSON(r, item)})
}

func (s *Server) attachRecording(w http.ResponseWriter, r *http.Request) {
	raw, err := readJSON(w, r, 32*1024)
	if err != nil {
		writeReadError(w, err, false)
		return
	}
	input, message := parseRecordingAttach(raw)
	if message != "" {
		writeError(w, http.StatusBadRequest, "bad_request", message)
		return
	}
	item, code, message := s.store.AttachRecording(r.PathValue("id"), input, s.now())
	if writeStoreError(w, code, message) {
		return
	}
	writeJSON(w, http.StatusOK, s.sessionJSON(r, item))
}

func (s *Server) uploadRecording(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.store.Get(id); !ok {
		writeError(w, http.StatusNotFound, "not_found", "Session not found")
		return
	}
	contentType, blob, status, message := readRecordingUpload(w, r)
	if status != http.StatusOK {
		code := "bad_request"
		if status == http.StatusRequestEntityTooLarge {
			code = "payload_too_large"
		}
		writeError(w, status, code, message)
		return
	}
	ext := "webm"
	if contentType == "video/mp4" {
		ext = "mp4"
	}
	playback := requestBase(r) + "/sessions/" + id + "/call-recording/file." + ext
	saved, code, message := s.store.SaveLocalRecording(id, session.LocalRecording{
		ContentType: contentType,
		Bytes:       blob,
		PlaybackURL: playback,
	}, s.now())
	if writeStoreError(w, code, message) {
		return
	}
	if saved.Kept {
		log.Printf("[vkyc] kept longer local recording %s; ignored a shorter upload (%d bytes)", saved.RecordingID, len(blob))
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"recordingId":  saved.RecordingID,
		"recordingUrl": saved.RecordingURL,
	})
}

func (s *Server) recordingFile(w http.ResponseWriter, r *http.Request) {
	contentType, blob, ok := s.store.RecordingFile(r.PathValue("id"))
	want := "video/webm"
	if strings.HasSuffix(r.URL.Path, ".mp4") {
		want = "video/mp4"
	}
	if !ok || contentType != want {
		writeError(w, http.StatusNotFound, "not_found", "Recording not found")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(blob)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(blob)
}

func (s *Server) deliverDisposition(r *http.Request, item *session.Session, disposition string) {
	if s.stubs == nil {
		return
	}
	captures := captureListJSON(r, item)
	summaries := make([]stub.Capture, 0, len(captures))
	for _, capture := range captures {
		summaries = append(summaries, stub.Capture{
			ID:          capture.ID,
			Kind:        capture.Kind,
			URL:         capture.URL,
			ContentType: capture.ContentType,
			CreatedAt:   capture.CreatedAt,
			CapturedAt:  capture.CapturedAt,
		})
	}
	s.stubs.Deliver(stub.Body{
		SessionID:   item.ID,
		Disposition: disposition,
		AgentID:     demoAgent(r),
		ClaimedBy:   nilIfEmpty(item.ClaimedBy),
		Timestamps: stub.Timestamps{
			CreatedAt:     formatTime(item.CreatedAt),
			AcceptedAt:    timePtr(item.AcceptedAt),
			EndedAt:       timePtr(item.EndedAt),
			DispositionAt: formatTime(s.now()),
		},
		Captures: summaries,
		Recording: stub.Recording{
			ID:  nilIfEmpty(item.RecordingID),
			URL: nilIfEmpty(item.RecordingURL),
		},
	})
}

func parseRecordingAttach(raw json.RawMessage) (session.RecordingAttach, string) {
	obj, message := parseObject(raw)
	if message != "" {
		return session.RecordingAttach{}, message
	}
	var input session.RecordingAttach
	if value, ok := obj["recordingUrl"]; ok {
		text, message := parseRecordingURL(value)
		if message != "" {
			return session.RecordingAttach{}, message
		}
		input.HasURL = true
		input.URL = text
	}
	if value, ok := obj["recordingId"]; ok {
		text, message := parseRecordingID(value)
		if message != "" {
			return session.RecordingAttach{}, message
		}
		input.HasID = true
		input.ID = text
	}
	if !input.HasURL && !input.HasID {
		return session.RecordingAttach{}, "recordingUrl or recordingId is required"
	}
	return input, ""
}

func parseRecordingURL(raw json.RawMessage) (string, string) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", "recordingUrl must be a string"
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", "recordingUrl must be an http(s) URL"
	}
	if len(text) > session.RecordingURLMax {
		return "", "recordingUrl must be 2048 characters or fewer"
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", "recordingUrl must be an http(s) URL"
	}
	return text, ""
}

func parseRecordingID(raw json.RawMessage) (string, string) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", "recordingId must be a string"
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", "recordingId must not be empty"
	}
	if len(text) > session.RecordingIDMax {
		return "", "recordingId must be 200 characters or fewer"
	}
	if strings.ContainsAny(text, "\r\n") {
		return "", "recordingId must not contain line breaks"
	}
	return text, ""
}

func readRecordingUpload(w http.ResponseWriter, r *http.Request) (string, []byte, int, string) {
	media := mediaBase(r.Header.Get("Content-Type"))
	switch media {
	case "video/webm", "video/mp4":
		blob, status, message := readLimited(w, r, session.RecordingMaxBytes)
		if status != http.StatusOK {
			return "", nil, status, message
		}
		if len(blob) == 0 {
			return "", nil, http.StatusBadRequest, "Recording file is empty"
		}
		return media, blob, http.StatusOK, ""
	case "multipart/form-data":
		return readMultipartVideo(w, r)
	default:
		return "", nil, http.StatusBadRequest, "video file is required (multipart field video, or a video/webm or video/mp4 body)"
	}
}

func readMultipartVideo(w http.ResponseWriter, r *http.Request) (string, []byte, int, string) {
	r.Body = http.MaxBytesReader(w, r.Body, session.RecordingMaxBytes+1<<20)
	reader, err := r.MultipartReader()
	if err != nil {
		return "", nil, http.StatusBadRequest, "video file is required (multipart field video, or a video/webm or video/mp4 body)"
	}
	var (
		contentType string
		blob        []byte
		found       bool
	)
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if tooLarge(err) {
				return "", nil, http.StatusRequestEntityTooLarge, "Recording must be 40 MB or smaller"
			}
			return "", nil, http.StatusBadRequest, "video file is required (multipart field video, or a video/webm or video/mp4 body)"
		}
		if part.FormName() != "video" {
			_, _ = io.Copy(io.Discard, part)
			_ = part.Close()
			continue
		}
		found = true
		contentType = mediaBase(part.Header.Get("Content-Type"))
		blob, err = io.ReadAll(io.LimitReader(part, session.RecordingMaxBytes+1))
		_ = part.Close()
		if err != nil {
			return "", nil, http.StatusBadRequest, "Could not read the recording"
		}
		if len(blob) > session.RecordingMaxBytes {
			return "", nil, http.StatusRequestEntityTooLarge, "Recording must be 40 MB or smaller"
		}
	}
	if !found {
		return "", nil, http.StatusBadRequest, "video file is required (multipart field video, or a video/webm or video/mp4 body)"
	}
	if contentType != "video/webm" && contentType != "video/mp4" {
		return "", nil, http.StatusBadRequest, "Recording must be video/webm or video/mp4"
	}
	if len(blob) == 0 {
		return "", nil, http.StatusBadRequest, "Recording file is empty"
	}
	return contentType, blob, http.StatusOK, ""
}

func readLimited(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, int, string) {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	blob, err := io.ReadAll(r.Body)
	if err != nil {
		if tooLarge(err) {
			return nil, http.StatusRequestEntityTooLarge, "Recording must be 40 MB or smaller"
		}
		return nil, http.StatusBadRequest, "Could not read the recording"
	}
	return blob, http.StatusOK, ""
}

func mediaBase(value string) string {
	base, _, _ := strings.Cut(value, ";")
	return strings.ToLower(strings.TrimSpace(base))
}

func tooLarge(err error) bool {
	var max *http.MaxBytesError
	if errors.As(err, &max) {
		return true
	}
	return errors.Is(err, multipart.ErrMessageTooLarge)
}
