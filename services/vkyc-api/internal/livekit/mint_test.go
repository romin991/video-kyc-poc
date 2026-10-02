package livekit

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
)

const (
	testKey    = "devkey"
	testSecret = "secretsecretsecretsecretsecret12"
)

func TestRoomName(t *testing.T) {
	name, err := RoomName("6f1e0b3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b")
	if err != nil {
		t.Fatal(err)
	}
	if name != "vkyc-6f1e0b3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b" {
		t.Fatalf("room = %q", name)
	}

	if _, err := RoomName(""); err == nil {
		t.Fatal("expected empty session id to fail")
	}
	if _, err := RoomName("has space"); err == nil {
		t.Fatal("expected spaced session id to fail")
	}
}

func TestMissingCredentialsReturnPlaceholder(t *testing.T) {
	room := "vkyc-unconfigured"
	minter := NewMinter(Credentials{})
	if got := minter.ParticipantToken(RoleAgent, room); got != PlaceholderParticipantToken(RoleAgent, room) {
		t.Fatalf("empty creds: %q", got)
	}

	blankSecret := NewMinter(Credentials{APIKey: "devkey", APISecret: "  "})
	if got := blankSecret.ParticipantToken(RoleCustomer, room); got != PlaceholderParticipantToken(RoleCustomer, room) {
		t.Fatalf("blank secret: %q", got)
	}
}

func TestParticipantTokenMintsRoomJoinJWT(t *testing.T) {
	room := "vkyc-mint"
	minter := NewMinter(Credentials{APIKey: testKey, APISecret: testSecret, ServerURL: "wss://example.livekit.cloud"})
	token := minter.ParticipantToken(RoleAgent, room)

	claims := verifyToken(t, token)
	if claims.Identity != RoleAgent {
		t.Fatalf("identity = %q", claims.Identity)
	}
	if claims.Video == nil {
		t.Fatal("missing video grant")
	}
	if claims.Video.Room != room || !claims.Video.RoomJoin {
		t.Fatalf("video grant = %+v", claims.Video)
	}
	if !claims.Video.GetCanPublish() || !claims.Video.GetCanSubscribe() {
		t.Fatalf("publish/subscribe = %+v", claims.Video)
	}

	header := decodePart(t, token, 1)
	var body struct {
		Iss string `json:"iss"`
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
		Nbf int64  `json:"nbf"`
	}
	if err := json.Unmarshal(header, &body); err != nil {
		t.Fatal(err)
	}
	if body.Iss != testKey || body.Sub != RoleAgent {
		t.Fatalf("iss/sub = %s %s", body.Iss, body.Sub)
	}
	ttl := body.Exp - body.Nbf
	if ttl < 540 || ttl > 660 {
		t.Fatalf("ttl = %d, want ~600s", ttl)
	}
}

func TestForRoleUsesVkycRoom(t *testing.T) {
	minter := NewMinter(Credentials{APIKey: testKey, APISecret: testSecret, ServerURL: "wss://proj.livekit.cloud"})
	media, err := minter.ForAccept("session-42")
	if err != nil {
		t.Fatal(err)
	}
	if media.RoomName != "vkyc-session-42" || media.Role != RoleAgent || !media.LiveKitConfigured {
		t.Fatalf("accept media = %+v", media)
	}
	if media.ServerURL != "wss://proj.livekit.cloud" {
		t.Fatalf("server url = %q", media.ServerURL)
	}
	claims := verifyToken(t, media.Token)
	if claims.Video.Room != "vkyc-session-42" || claims.Identity != RoleAgent {
		t.Fatalf("claims identity=%s room=%s", claims.Identity, claims.Video.Room)
	}

	customer, err := minter.ForJoin("session-42")
	if err != nil {
		t.Fatal(err)
	}
	if customer.Role != RoleCustomer || customer.RoomName != media.RoomName {
		t.Fatalf("join media = %+v", customer)
	}
	if customer.Token == media.Token {
		t.Fatal("agent and customer must not share a token")
	}
}

func TestTokenReusedUntilNearExpiry(t *testing.T) {
	start := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	minter := NewMinter(Credentials{APIKey: testKey, APISecret: testSecret})
	minter.now = func() time.Time { return start }
	signs := 0
	minter.sign = func(apiKey, apiSecret, role, roomName string, ttl time.Duration) (string, error) {
		signs++
		return sign(apiKey, apiSecret, role, roomName, ttl)
	}

	room := "vkyc-cache"
	first := minter.ParticipantToken(RoleCustomer, room)
	second := minter.ParticipantToken(RoleCustomer, room)
	agent := minter.ParticipantToken(RoleAgent, room)
	if first != second {
		t.Fatal("expected the customer token to be reused")
	}
	if agent == first {
		t.Fatal("expected a distinct agent token")
	}
	if signs != 2 {
		t.Fatalf("signs after reuse = %d, want 2", signs)
	}

	minter.now = func() time.Time { return start.Add(tokenTTL - refreshBefore) }
	refreshed := minter.ParticipantToken(RoleCustomer, room)
	if signs != 3 {
		t.Fatalf("signs after refresh = %d, want 3", signs)
	}
	claims := verifyToken(t, refreshed)
	if claims.Identity != RoleCustomer || claims.Video.Room != room {
		t.Fatalf("refreshed claims = %+v", claims)
	}
}

func TestForRoleRejectsBadInput(t *testing.T) {
	minter := NewMinter(Credentials{APIKey: testKey, APISecret: testSecret})
	if _, err := minter.ForRole("observer", "session-1"); err == nil {
		t.Fatal("expected unknown role to fail")
	}
	if _, err := minter.ForAccept("../etc"); err == nil {
		t.Fatal("expected unsafe session id to fail")
	}
}

func verifyToken(t *testing.T, token string) *auth.ClaimGrants {
	t.Helper()
	parsed, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if parsed.APIKey() != testKey {
		t.Fatalf("api key = %q", parsed.APIKey())
	}
	claims, err := parsed.Verify(testSecret)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	return claims
}

func decodePart(t *testing.T, token string, index int) []byte {
	t.Helper()
	parts := splitToken(token)
	raw, err := base64.RawURLEncoding.DecodeString(parts[index])
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func splitToken(token string) []string {
	parts := make([]string, 0, 3)
	start := 0
	for i := 0; i < len(token); i++ {
		if token[i] == '.' {
			parts = append(parts, token[start:i])
			start = i + 1
		}
	}
	return append(parts, token[start:])
}
