// Package session is the in-memory P0 call store.
// Restarting the process drops every session and invalidates join links.
package session

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"sync"
	"time"
)

// Status is the session lifecycle. Create leaves a session waiting.
// Claim and accept are the only transitions into in_call.
type Status string

const (
	StatusWaiting Status = "waiting"
	StatusInCall  Status = "in_call"
	StatusEnded   Status = "ended"
)

// Session is one video-KYC call shell.
type Session struct {
	ID         string
	JoinToken  string
	Status     Status
	RoomName   string
	CreatedAt  time.Time
	CreatedBy  string
	ClaimedBy  string
	AcceptedAt time.Time
	EndedAt    time.Time
	arrival    int
}

// Store is safe for concurrent HTTP handlers.
type Store struct {
	mu       sync.Mutex
	sessions map[string]*Session
	byToken  map[string]string
	arrival  int
}

func NewStore() *Store {
	return &Store{
		sessions: make(map[string]*Session),
		byToken:  make(map[string]string),
	}
}

// RoomName is the LiveKit room for a session. The contract is vkyc-${sessionId}.
func RoomName(sessionID string) string {
	return "vkyc-" + sessionID
}

// Create stores a waiting session. The join token is not the session id.
func (s *Store) Create(createdBy string, now time.Time) *Session {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.arrival++
	session := &Session{
		ID:        newSessionID(),
		JoinToken: newJoinToken(),
		Status:    StatusWaiting,
		RoomName:  RoomName(""),
		CreatedAt: now.UTC(),
		CreatedBy: createdBy,
		arrival:   s.arrival,
	}
	session.RoomName = RoomName(session.ID)
	s.sessions[session.ID] = session
	s.byToken[session.JoinToken] = session.ID
	return clone(session)
}

// Get returns a copy, or false when the id is unknown.
func (s *Store) Get(id string) (*Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	if !ok {
		return nil, false
	}
	return clone(session), true
}

// GetByToken resolves a customer join link.
func (s *Store) GetByToken(token string) (*Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.byToken[token]
	if !ok {
		return nil, false
	}
	session, ok := s.sessions[id]
	if !ok {
		return nil, false
	}
	return clone(session), true
}

// List returns copies. Waiting sessions are oldest-first.
// Every other filter, including no filter, is newest-first.
func (s *Store) List(status Status) []*Session {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]*Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		if status != "" && session.Status != status {
			continue
		}
		out = append(out, clone(session))
	}
	if status == StatusWaiting {
		sortWaiting(out)
		return out
	}
	sortNewest(out)
	return out
}

// QueuePosition is the 1-based place among waiting sessions.
// It is zero once the session is in call or ended, or when it does not exist.
func (s *Store) QueuePosition(id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	waiting := make([]*Session, 0)
	for _, session := range s.sessions {
		if session.Status == StatusWaiting {
			waiting = append(waiting, session)
		}
	}
	sortWaiting(waiting)
	for i, session := range waiting {
		if session.ID == id {
			return i + 1
		}
	}
	return 0
}

type AcceptError string

const (
	ErrNotFound AcceptError = "not_found"
	ErrConflict AcceptError = "conflict"
	ErrEmpty    AcceptError = "empty"
)

// Accept moves one waiting session to in_call.
// A second accept, or accept after end, is a conflict and returns the current copy.
func (s *Store) Accept(id, claimedBy string, now time.Time) (*Session, AcceptError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	if session.Status != StatusWaiting {
		return clone(session), ErrConflict
	}
	session.Status = StatusInCall
	session.AcceptedAt = now.UTC()
	session.ClaimedBy = claimedBy
	return clone(session), ""
}

// ClaimNext accepts the oldest waiting session.
// One claim moves one session. Everyone else stays waiting.
func (s *Store) ClaimNext(claimedBy string, now time.Time) (*Session, AcceptError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var next *Session
	for _, session := range s.sessions {
		if session.Status != StatusWaiting {
			continue
		}
		if next == nil || beforeWaiting(session, next) {
			next = session
		}
	}
	if next == nil {
		return nil, ErrEmpty
	}
	next.Status = StatusInCall
	next.AcceptedAt = now.UTC()
	next.ClaimedBy = claimedBy
	return clone(next), ""
}

// End marks the session ended. Ending again is a success and keeps the first endedAt.
func (s *Store) End(id string, now time.Time) (*Session, AcceptError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	if session.Status != StatusEnded {
		session.Status = StatusEnded
		session.EndedAt = now.UTC()
	}
	return clone(session), ""
}

func clone(session *Session) *Session {
	copy := *session
	return &copy
}

func beforeWaiting(a, b *Session) bool {
	if a.CreatedAt.Equal(b.CreatedAt) {
		return a.arrival < b.arrival
	}
	return a.CreatedAt.Before(b.CreatedAt)
}

func sortWaiting(list []*Session) {
	for i := 1; i < len(list); i++ {
		item := list[i]
		j := i
		for j > 0 && beforeWaiting(item, list[j-1]) {
			list[j] = list[j-1]
			j--
		}
		list[j] = item
	}
}

func sortNewest(list []*Session) {
	for i := 1; i < len(list); i++ {
		item := list[i]
		j := i
		for j > 0 && newer(item, list[j-1]) {
			list[j] = list[j-1]
			j--
		}
		list[j] = item
	}
}

func newer(a, b *Session) bool {
	if a.CreatedAt.Equal(b.CreatedAt) {
		return a.ID > b.ID
	}
	return a.CreatedAt.After(b.CreatedAt)
}

func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func newJoinToken() string {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}
