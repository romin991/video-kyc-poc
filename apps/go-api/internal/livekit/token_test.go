package livekit

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const (
	testKey    = "devkey"
	testSecret = "secretsecretsecretsecretsecret12"
)

func TestMissingCredentialsReturnStub(t *testing.T) {
	room := "vkyc-unconfigured"
	client := New("", "")
	if got := client.ParticipantToken("agent", room); got != "lk-stub-agent-"+room {
		t.Fatalf("agent stub = %q", got)
	}
	if got := New("", "secret").ParticipantToken("customer", room); got != "lk-stub-customer-"+room {
		t.Fatalf("customer stub = %q", got)
	}
}

func TestParticipantTokenMintsRoomJoinJWT(t *testing.T) {
	room := "vkyc-mint"
	token := New(testKey, testSecret).ParticipantToken("agent", room)
	claims := decodeClaims(t, token)

	if claims["iss"] != testKey {
		t.Fatalf("iss = %v", claims["iss"])
	}
	if claims["sub"] != "agent" {
		t.Fatalf("sub = %v", claims["sub"])
	}
	video, _ := claims["video"].(map[string]any)
	if video["room"] != room {
		t.Fatalf("room = %v", video["room"])
	}
	if video["roomJoin"] != true {
		t.Fatalf("roomJoin = %v", video["roomJoin"])
	}
	if video["canPublish"] != true || video["canSubscribe"] != true {
		t.Fatalf("grants = %#v", video)
	}

	exp, _ := claims["exp"].(float64)
	nbf, _ := claims["nbf"].(float64)
	ttl := exp - nbf
	if ttl < 540 || ttl > 660 {
		t.Fatalf("ttl = %v, want ~600s", ttl)
	}
}

func TestTokenReuseUntilNearExpiry(t *testing.T) {
	room := "vkyc-cache"
	client := New(testKey, testSecret)
	first := client.ParticipantToken("customer", room)
	second := client.ParticipantToken("customer", room)
	agent := client.ParticipantToken("agent", room)
	if first != second {
		t.Fatal("customer token was not reused")
	}
	if agent == first {
		t.Fatal("agent token matched the customer token")
	}
	claims := decodeClaims(t, first)
	if claims["sub"] != "customer" {
		t.Fatalf("sub = %v", claims["sub"])
	}
	video, _ := claims["video"].(map[string]any)
	if video["room"] != room {
		t.Fatalf("room = %v", video["room"])
	}
	if time.Until(time.Unix(int64(claims["exp"].(float64)), 0)) < 8*time.Minute {
		t.Fatal("cached token expires too soon")
	}
}

func decodeClaims(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token parts = %d", len(parts))
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}
