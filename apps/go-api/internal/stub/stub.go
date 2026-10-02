// Package stub delivers the CRM and datalake payloads for a saved disposition.
// Each body is logged and kept in memory. A configured URL also receives a POST.
package stub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	webhookTimeout = 8 * time.Second
	maxStored      = 500
)

// Sinks are the two after-call targets. Order is stable for QA evidence.
var Sinks = []string{"crm", "datalake"}

// Capture is one still summary inside the stub body.
type Capture struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	URL         string `json:"url"`
	ContentType string `json:"contentType"`
	CreatedAt   string `json:"createdAt"`
	CapturedAt  string `json:"capturedAt"`
}

// Timestamps are the session clock plus the moment the disposition was saved.
type Timestamps struct {
	CreatedAt     string  `json:"createdAt"`
	AcceptedAt    *string `json:"acceptedAt"`
	EndedAt       *string `json:"endedAt"`
	DispositionAt string  `json:"dispositionAt"`
}

// Recording is the attached call file, when one exists.
type Recording struct {
	ID  *string `json:"id"`
	URL *string `json:"url"`
}

// Body is the request body shared by both sinks.
type Body struct {
	SessionID   string     `json:"sessionId"`
	Disposition string     `json:"disposition"`
	AgentID     string     `json:"agentId"`
	ClaimedBy   *string    `json:"claimedBy"`
	Timestamps  Timestamps `json:"timestamps"`
	Captures    []Capture  `json:"captures"`
	Recording   Recording  `json:"recording"`
}

type envelope struct {
	Sink         string     `json:"sink"`
	SessionID    string     `json:"sessionId"`
	Disposition  string     `json:"disposition"`
	AgentID      string     `json:"agentId"`
	ClaimedBy    *string    `json:"claimedBy"`
	Timestamps   Timestamps `json:"timestamps"`
	Captures     []Capture  `json:"captures"`
	Recording    Recording  `json:"recording"`
	WebhookError string     `json:"webhookError,omitempty"`
}

// Service posts, logs, and stores disposition bodies.
type Service struct {
	crmURL  string
	lakeURL string
	logPath string
	client  *http.Client

	mu    sync.Mutex
	saved []json.RawMessage
}

// New builds a stub service. Blank webhook URLs stay in memory and the log.
// A blank logPath skips the file and still keeps the in-memory copy.
func New(crmURL, lakeURL, logPath string) *Service {
	return &Service{
		crmURL:  crmURL,
		lakeURL: lakeURL,
		logPath: logPath,
		client:  &http.Client{Timeout: webhookTimeout},
		saved:   []json.RawMessage{},
	}
}

// Describe is the one-line startup summary.
func (s *Service) Describe() string {
	logWhere := "stdout and memory"
	if s.logPath != "" {
		logWhere = s.logPath
	}
	return fmt.Sprintf(
		"disposition stubs: crm %s; datalake %s; log %s; evidence GET /disposition-stubs",
		sinkMode(s.crmURL),
		sinkMode(s.lakeURL),
		logWhere,
	)
}

func sinkMode(url string) string {
	if url == "" {
		return "in-memory"
	}
	return "webhook " + url
}

// Deliver sends one body per sink. A webhook failure is stored on that body
// and does not fail the disposition save.
func (s *Service) Deliver(body Body) {
	if body.Captures == nil {
		body.Captures = []Capture{}
	}
	out := make([]json.RawMessage, len(Sinks))
	var wg sync.WaitGroup
	for i, sink := range Sinks {
		wg.Add(1)
		go func(i int, sink string) {
			defer wg.Done()
			out[i] = s.postOne(sink, body)
		}(i, sink)
	}
	wg.Wait()
	for _, payload := range out {
		s.keep(payload)
	}
}

// List returns the stored request bodies, oldest first.
func (s *Service) List() []json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]json.RawMessage, len(s.saved))
	for i, item := range s.saved {
		out[i] = append(json.RawMessage(nil), item...)
	}
	return out
}

func (s *Service) postOne(sink string, body Body) json.RawMessage {
	payload := envelope{
		Sink:        sink,
		SessionID:   body.SessionID,
		Disposition: body.Disposition,
		AgentID:     body.AgentID,
		ClaimedBy:   body.ClaimedBy,
		Timestamps:  body.Timestamps,
		Captures:    body.Captures,
		Recording:   body.Recording,
	}
	raw, err := marshal(payload)
	if err != nil {
		log.Printf("[vkyc] disposition stub %s encode failed: %v", sink, err)
		return nil
	}
	url := s.crmURL
	if sink == "datalake" {
		url = s.lakeURL
	}
	if url == "" {
		return raw
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		payload.WebhookError = err.Error()
		return mustMarshal(payload)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		log.Printf("[vkyc] disposition stub %s webhook failed: %s", sink, err.Error())
		payload.WebhookError = err.Error()
		return mustMarshal(payload)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		message := fmt.Sprintf("webhook returned %d", res.StatusCode)
		log.Printf("[vkyc] disposition stub %s webhook failed: %s", sink, message)
		payload.WebhookError = message
		return mustMarshal(payload)
	}
	return raw
}

func (s *Service) keep(payload json.RawMessage) {
	if len(payload) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saved = append(s.saved, append(json.RawMessage(nil), payload...))
	if len(s.saved) > maxStored {
		s.saved = append([]json.RawMessage(nil), s.saved[len(s.saved)-maxStored:]...)
	}
	log.Printf("[vkyc] disposition stub %s", payload)
	if s.logPath == "" {
		return
	}
	if err := appendLog(s.logPath, payload); err != nil {
		log.Printf("[vkyc] disposition stub log failed: %v", err)
	}
}

func appendLog(path string, payload json.RawMessage) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(append([]byte(nil), payload...), '\n'))
	return err
}

func marshal(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buf.Bytes()), nil
}

func mustMarshal(value any) json.RawMessage {
	raw, err := marshal(value)
	if err != nil {
		return nil
	}
	return raw
}
