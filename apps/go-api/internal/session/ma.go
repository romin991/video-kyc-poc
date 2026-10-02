package session

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"
)

// Update applies a desk patch. Manual checklist writes land first.
// A pass or fail for identity then overwrites that tick.
// Digit pass ticks liveness and does not clear it on fail.
func (s *Store) Update(id string, patch Patch, now time.Time) (*Session, AcceptError, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound, "Session not found"
	}
	if patch.HasChecklist {
		for _, item := range patch.Checklist {
			found := false
			for _, existing := range session.Checklist {
				if existing.ID == item.ID {
					found = true
					break
				}
			}
			if !found {
				return nil, ErrBadRequest, "Unknown checklist item: " + item.ID
			}
		}
	}
	if patch.HasDisposition && patch.Disposition != nil {
		if session.Status != StatusEnded {
			return nil, ErrConflict, "Disposition is saved in after-call work, once the session has ended"
		}
		if len(session.Captures) == 0 {
			return nil, ErrCaptureRequired, "Add at least one still before setting a disposition"
		}
	}
	if patch.HasChecklist {
		for _, item := range patch.Checklist {
			setChecklist(session.Checklist, item.ID, item.Checked)
		}
	}
	if patch.HasCaptureGuide {
		session.CaptureGuide = patch.CaptureGuide
	}
	if patch.HasMaPrompt {
		if patch.MaPrompt == nil {
			session.MaPrompt = nil
		} else {
			session.MaPrompt = &MaPrompt{
				Field:  patch.MaPrompt.Field,
				Prompt: patch.MaPrompt.Prompt,
				SentAt: now.UTC(),
			}
		}
	}
	if patch.HasDigit {
		if patch.Digits == nil {
			session.DigitChallenge = nil
		} else {
			session.DigitChallenge = &DigitChallenge{
				Digits: *patch.Digits,
				Prompt: DigitPrompt(*patch.Digits),
				SentAt: now.UTC(),
			}
			session.DigitResponse = nil
			session.DigitRespondedAt = time.Time{}
		}
	}
	if patch.HasMaMatch {
		session.MaMatch = patch.MaMatch
	}
	if patch.HasDigitMatch {
		session.DigitMatch = patch.DigitMatch
	}
	if patch.HasMaMatch && patch.MaMatch != nil {
		setChecklist(session.Checklist, "identity_match", *patch.MaMatch)
	}
	if patch.HasDigitMatch && patch.DigitMatch != nil && *patch.DigitMatch {
		tickChecklist(session.Checklist, "liveness_digits")
	}
	if patch.HasAcwNotes {
		session.AcwNotes = patch.AcwNotes
	}
	if patch.HasDisposition {
		if patch.Disposition == nil {
			session.Disposition = ""
		} else {
			session.Disposition = *patch.Disposition
		}
	}
	return clone(session), "", ""
}

// RecordReply stores a customer answer against the open prompt.
// An answer clears the question. A digit reply clears the challenge,
// keeps the typed text, and ticks liveness. The call must be open.
func (s *Store) RecordReply(id string, reply Reply, now time.Time) (*Session, AcceptError, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound, "Session not found"
	}
	if session.Status != StatusInCall {
		return nil, ErrConflict, "Replies are accepted while the call is open"
	}
	if reply.Answer != nil && session.MaPrompt == nil {
		return nil, ErrConflict, "No manual authentication question is waiting"
	}
	if reply.DigitResponse != nil && session.DigitChallenge == nil {
		return nil, ErrConflict, "No digit prompt is waiting"
	}

	if reply.Answer != nil && session.MaPrompt != nil {
		upsertAnswer(session, MaAnswer{
			Field:      session.MaPrompt.Field,
			Prompt:     session.MaPrompt.Prompt,
			Answer:     *reply.Answer,
			AnsweredAt: now.UTC(),
		})
		session.MaPrompt = nil
	}
	if reply.DigitResponse != nil && session.DigitChallenge != nil {
		value := *reply.DigitResponse
		session.DigitResponse = &value
		session.DigitRespondedAt = now.UTC()
		session.DigitChallenge = nil
		tickChecklist(session.Checklist, "liveness_digits")
	}
	return clone(session), "", ""
}

// AddCapture stores one JPEG or PNG. Document kinds tick Documents shown.
func (s *Store) AddCapture(id string, kind CaptureKind, contentType string, blob []byte, capturedAt, now time.Time) (*Session, Capture, AcceptError, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return nil, Capture{}, ErrNotFound, "Session not found"
	}
	if len(session.Captures) >= CaptureMaxCount {
		return nil, Capture{}, ErrLimit, fmt.Sprintf("A session can store %d stills", CaptureMaxCount)
	}

	capture := Capture{
		ID:          newCaptureID(),
		Kind:        kind,
		ContentType: contentType,
		CreatedAt:   now.UTC(),
		CapturedAt:  capturedAt.UTC(),
	}
	stored := make([]byte, len(blob))
	copy(stored, blob)
	s.blobs[capture.ID] = stored
	session.Captures = append(session.Captures, capture)
	if ShowsDocs(kind) {
		tickChecklist(session.Checklist, "docs_shown")
	}
	return clone(session), capture, "", ""
}

// CaptureBytes returns a copy of one still, or false when it is missing.
func (s *Store) CaptureBytes(sessionID, captureID string) (string, []byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[sessionID]
	if !ok {
		return "", nil, false
	}
	var contentType string
	found := false
	for _, capture := range session.Captures {
		if capture.ID == captureID {
			contentType = capture.ContentType
			found = true
			break
		}
	}
	if !found {
		return "", nil, false
	}
	blob, ok := s.blobs[captureID]
	if !ok {
		return "", nil, false
	}
	out := make([]byte, len(blob))
	copy(out, blob)
	return contentType, out, true
}

func upsertAnswer(session *Session, next MaAnswer) {
	for i := range session.MaAnswers {
		if session.MaAnswers[i].Field != next.Field {
			continue
		}
		session.MaAnswers[i] = next
		kept := append([]MaAnswer(nil), session.MaAnswers[:i+1]...)
		for _, item := range session.MaAnswers[i+1:] {
			if item.Field != next.Field {
				kept = append(kept, item)
			}
		}
		session.MaAnswers = kept
		return
	}
	session.MaAnswers = append(session.MaAnswers, next)
	if len(session.MaAnswers) > 20 {
		session.MaAnswers = append([]MaAnswer(nil), session.MaAnswers[len(session.MaAnswers)-20:]...)
	}
}

func newCaptureID() string {
	buf := make([]byte, 9)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	return "cap_" + base64.RawURLEncoding.EncodeToString(buf)
}
