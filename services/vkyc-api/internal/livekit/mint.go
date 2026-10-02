// Package livekit mints participant JWTs for the Video KYC room.
//
// Session create, join, claim, and end stay with the session API. Accept
// should call ForAccept and the customer join should call ForJoin, then put
// RoomName and Token on the response the browsers already expect.
package livekit

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/livekit/protocol/auth"
)

const (
	RoleAgent    = "agent"
	RoleCustomer = "customer"

	tokenTTL         = 10 * time.Minute
	refreshBefore    = 60 * time.Second
	maxSessionIDSize = 128
)

// Credentials are the LiveKit Cloud API key pair. Empty values mint a
// non-connecting placeholder so accept and join can still succeed.
type Credentials struct {
	APIKey    string
	APISecret string
	// ServerURL is the project WebSocket URL (wss://….livekit.cloud).
	// It is returned to clients; it is not part of the JWT.
	ServerURL string
}

// CredentialsFromEnv reads LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL.
func CredentialsFromEnv(getenv func(string) string) Credentials {
	return Credentials{
		APIKey:    strings.TrimSpace(getenv("LIVEKIT_API_KEY")),
		APISecret: strings.TrimSpace(getenv("LIVEKIT_API_SECRET")),
		ServerURL: strings.TrimSpace(getenv("LIVEKIT_URL")),
	}
}

// ParticipantMedia is the media payload accept and join should attach.
type ParticipantMedia struct {
	SessionID         string `json:"sessionId"`
	RoomName          string `json:"roomName"`
	Role              string `json:"role"`
	Token             string `json:"token"`
	ServerURL         string `json:"serverUrl"`
	LiveKitConfigured bool   `json:"livekitConfigured"`
}

type cachedToken struct {
	token     string
	expiresAt time.Time
}

type accessSigner func(apiKey, apiSecret, role, roomName string, ttl time.Duration) (string, error)

// Minter signs LiveKit access tokens. A token for the same key, role, and
// room is reused until it is within a minute of expiry so a join poll does
// not force the browser to reconnect.
type Minter struct {
	creds Credentials
	now   func() time.Time
	sign  accessSigner

	mu    sync.Mutex
	cache map[string]cachedToken
}

func NewMinter(creds Credentials) *Minter {
	return &Minter{
		creds: Credentials{
			APIKey:    strings.TrimSpace(creds.APIKey),
			APISecret: strings.TrimSpace(creds.APISecret),
			ServerURL: strings.TrimSpace(creds.ServerURL),
		},
		now:   time.Now,
		sign:  sign,
		cache: map[string]cachedToken{},
	}
}

// RoomName is vkyc-${sessionId}, the LiveKit Cloud room for this session.
func RoomName(sessionID string) (string, error) {
	if err := validateSessionID(sessionID); err != nil {
		return "", err
	}
	return "vkyc-" + sessionID, nil
}

// PlaceholderParticipantToken is the non-connecting stand-in used when the
// API key or secret is missing, or when signing fails.
func PlaceholderParticipantToken(role, roomName string) string {
	return "lk-stub-" + role + "-" + roomName
}

// ForAccept is the agent token for POST /sessions/:id/accept and claim.
func (m *Minter) ForAccept(sessionID string) (ParticipantMedia, error) {
	return m.ForRole(RoleAgent, sessionID)
}

// ForJoin is the customer token for GET /join/:token.
func (m *Minter) ForJoin(sessionID string) (ParticipantMedia, error) {
	return m.ForRole(RoleCustomer, sessionID)
}

// ForRole mints media credentials for agent or customer in vkyc-${sessionID}.
func (m *Minter) ForRole(role, sessionID string) (ParticipantMedia, error) {
	if role != RoleAgent && role != RoleCustomer {
		return ParticipantMedia{}, fmt.Errorf("role must be %q or %q", RoleAgent, RoleCustomer)
	}
	roomName, err := RoomName(sessionID)
	if err != nil {
		return ParticipantMedia{}, err
	}
	token := m.ParticipantToken(role, roomName)
	return ParticipantMedia{
		SessionID:         sessionID,
		RoomName:          roomName,
		Role:              role,
		Token:             token,
		ServerURL:         m.creds.ServerURL,
		LiveKitConfigured: IsLiveKitJWT(token),
	}, nil
}

// ParticipantToken returns a LiveKit JWT, or a placeholder when signing is
// not configured. It does not fail the caller: the session shell still
// accepts and joins with cameras off.
func (m *Minter) ParticipantToken(role, roomName string) string {
	apiKey := m.creds.APIKey
	apiSecret := m.creds.APISecret
	if apiKey == "" || apiSecret == "" {
		return PlaceholderParticipantToken(role, roomName)
	}

	cacheKey := apiKey + ":" + apiSecret + ":" + role + ":" + roomName
	now := m.now()

	m.mu.Lock()
	cached, ok := m.cache[cacheKey]
	if ok && cached.expiresAt.Sub(now) > refreshBefore {
		token := cached.token
		m.mu.Unlock()
		return token
	}
	m.mu.Unlock()

	token, err := m.sign(apiKey, apiSecret, role, roomName, tokenTTL)
	if err != nil {
		log.Printf("[vkyc] LiveKit token mint failed; continuing without media: %v", err)
		return PlaceholderParticipantToken(role, roomName)
	}

	m.mu.Lock()
	m.cache[cacheKey] = cachedToken{token: token, expiresAt: now.Add(tokenTTL)}
	m.mu.Unlock()
	return token
}

func sign(apiKey, apiSecret, role, roomName string, ttl time.Duration) (string, error) {
	grant := &auth.VideoGrant{
		RoomJoin: true,
		Room:     roomName,
	}
	grant.SetCanPublish(true)
	grant.SetCanSubscribe(true)

	at := auth.NewAccessToken(apiKey, apiSecret)
	at.SetVideoGrant(grant).SetIdentity(role).SetValidFor(ttl)
	return at.ToJWT()
}

// IsLiveKitJWT reports whether token has the three-segment JWT shape the
// browsers require before Room.connect. Placeholders (lk-stub-…) do not.
func IsLiveKitJWT(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
	}
	return true
}

func validateSessionID(sessionID string) error {
	if sessionID == "" || len(sessionID) > maxSessionIDSize {
		return fmt.Errorf("session id must be 1–%d characters", maxSessionIDSize)
	}
	for _, r := range sessionID {
		if r > unicode.MaxASCII || unicode.IsControl(r) || unicode.IsSpace(r) {
			return fmt.Errorf("session id must be printable ASCII without spaces")
		}
		switch r {
		case '/', '\\', '?', '#', '%':
			return fmt.Errorf("session id must not contain %q", r)
		}
	}
	return nil
}
