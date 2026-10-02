package session

import (
	"crypto/rand"
	"encoding/base64"
	"time"
)

// localRecording is one browser WebM or MP4 kept for the ACW player.
// LiveKit egress does not live here. A later attach can replace the URL.
type localRecording struct {
	contentType string
	bytes       []byte
}

// RecordingAttach updates the playback URL and/or the recording id.
// A field that was omitted stays as it is. Any session status is valid.
type RecordingAttach struct {
	HasURL bool
	URL    string
	HasID  bool
	ID     string
}

// LocalRecording is a WebM or MP4 uploaded for the desk player.
type LocalRecording struct {
	ContentType string
	Bytes       []byte
	PlaybackURL string
}

// SavedRecording is what the attach response shows. Kept means a shorter
// upload was ignored and the longer file is still the one on disk.
type SavedRecording struct {
	RecordingID  string
	RecordingURL string
	Kept         bool
}

// AttachRecording stores a recording URL and/or id. Egress often finishes
// as the call ends, so waiting, in-call, and ended sessions all accept it.
func (s *Store) AttachRecording(id string, input RecordingAttach, now time.Time) (*Session, AcceptError, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound, "Session not found"
	}
	if input.HasURL {
		session.RecordingURL = input.URL
	}
	if input.HasID {
		session.RecordingID = input.ID
	}
	session.RecordingAttachedAt = now.UTC()
	return clone(session), "", ""
}

// SaveLocalRecording stores WebM or MP4 bytes and points recordingUrl at them.
// A shorter upload does not replace a longer one.
func (s *Store) SaveLocalRecording(id string, input LocalRecording, now time.Time) (SavedRecording, AcceptError, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return SavedRecording{}, ErrNotFound, "Session not found"
	}
	if len(input.Bytes) == 0 {
		return SavedRecording{}, ErrBadRequest, "Recording file is empty"
	}

	existing, exists := s.recordings[id]
	if exists && len(input.Bytes) < len(existing.bytes) {
		recordingID := session.RecordingID
		if recordingID == "" {
			recordingID = newLocalRecordingID()
			session.RecordingID = recordingID
		}
		return SavedRecording{
			RecordingID:  recordingID,
			RecordingURL: input.PlaybackURL,
			Kept:         true,
		}, "", ""
	}
	recordingID := session.RecordingID
	if !hasLocalPrefix(recordingID) {
		recordingID = newLocalRecordingID()
	}

	stored := make([]byte, len(input.Bytes))
	copy(stored, input.Bytes)
	s.recordings[id] = localRecording{contentType: input.ContentType, bytes: stored}
	session.RecordingID = recordingID
	session.RecordingURL = input.PlaybackURL
	session.RecordingAttachedAt = now.UTC()
	return SavedRecording{
		RecordingID:  recordingID,
		RecordingURL: input.PlaybackURL,
	}, "", ""
}

// RecordingFile returns a copy of the local recording, or false when none is stored.
func (s *Store) RecordingFile(id string) (string, []byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[id]; !ok {
		return "", nil, false
	}
	file, ok := s.recordings[id]
	if !ok || len(file.bytes) == 0 {
		return "", nil, false
	}
	out := make([]byte, len(file.bytes))
	copy(out, file.bytes)
	return file.contentType, out, true
}

func hasLocalPrefix(id string) bool {
	return len(id) >= 6 && id[:6] == "local_"
}

func newLocalRecordingID() string {
	buf := make([]byte, 9)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	return "local_" + base64.RawURLEncoding.EncodeToString(buf)
}
