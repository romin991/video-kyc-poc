// Package livekit mints participant JWTs for room vkyc-${sessionId}.
//
// This is the Go equivalent of livekit-server-sdk AccessToken. Browser
// Room.connect, camera publish, and End teardown live in packages/vkyc-livekit.
package livekit

import (
	"log"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
)

const (
	tokenTTL      = 10 * time.Minute
	refreshBefore = 60 * time.Second
	stubPrefix    = "lk-stub-"
)

// Minter issues a participant token. HTTP handlers depend on this small
// surface so a replacement mint package can be wired in one place.
type Minter interface {
	ParticipantToken(role, roomName string) string
}

// Client mints LiveKit JWTs. Missing credentials, or a mint error, produce a
// non-connecting lk-stub- token so accept and join still succeed.
type Client struct {
	apiKey    string
	apiSecret string

	mu    sync.Mutex
	cache map[string]cachedToken
}

type cachedToken struct {
	token     string
	expiresAt time.Time
}

// New returns a minter. Blank key or secret disables real JWTs.
func New(apiKey, apiSecret string) *Client {
	return &Client{
		apiKey:    apiKey,
		apiSecret: apiSecret,
		cache:     make(map[string]cachedToken),
	}
}

// ParticipantToken is a LiveKit JWT for identity `agent` or `customer`.
// Grants are roomJoin, canPublish, and canSubscribe. TTL is 10 minutes.
// The same token is reused until it is within a minute of expiry so the
// customer join poll does not reconnect the room.
func (c *Client) ParticipantToken(role, roomName string) string {
	if c == nil || c.apiKey == "" || c.apiSecret == "" {
		return placeholder(role, roomName)
	}

	cacheKey := c.apiKey + ":" + c.apiSecret + ":" + role + ":" + roomName
	now := time.Now()

	c.mu.Lock()
	if cached, ok := c.cache[cacheKey]; ok && cached.expiresAt.Sub(now) > refreshBefore {
		token := cached.token
		c.mu.Unlock()
		return token
	}
	c.mu.Unlock()

	canPublish := true
	canSubscribe := true
	token, err := auth.NewAccessToken(c.apiKey, c.apiSecret).
		SetIdentity(role).
		SetValidFor(tokenTTL).
		SetVideoGrant(&auth.VideoGrant{
			RoomJoin:     true,
			Room:         roomName,
			CanPublish:   &canPublish,
			CanSubscribe: &canSubscribe,
		}).
		ToJWT()
	if err != nil {
		log.Printf("[vkyc] LiveKit token mint failed; continuing without media: %v", err)
		return placeholder(role, roomName)
	}

	c.mu.Lock()
	c.cache[cacheKey] = cachedToken{token: token, expiresAt: now.Add(tokenTTL)}
	c.mu.Unlock()
	return token
}

func placeholder(role, roomName string) string {
	return stubPrefix + role + "-" + roomName
}
