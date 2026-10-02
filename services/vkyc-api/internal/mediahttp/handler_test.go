package mediahttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/romin991/video-kyc-poc/services/vkyc-api/internal/livekit"
)

func TestMintEndpointReturnsRoomJWT(t *testing.T) {
	srv := testServer(t, livekit.Credentials{
		APIKey:    "devkey",
		APISecret: "secretsecretsecretsecretsecret12",
		ServerURL: "wss://example.livekit.cloud",
	})

	res := postJSON(t, srv, "/media/tokens", `{"sessionId":"abc-1","role":"customer"}`, "http://127.0.0.1:3101")
	if res.Code != http.StatusOK {
		t.Fatalf("status %d body %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:3101" {
		t.Fatalf("cors origin = %q", got)
	}

	var media livekit.ParticipantMedia
	if err := json.Unmarshal(res.Body.Bytes(), &media); err != nil {
		t.Fatal(err)
	}
	if media.RoomName != "vkyc-abc-1" || media.Role != "customer" || !media.LiveKitConfigured {
		t.Fatalf("media = %+v", media)
	}
	if !strings.Contains(media.Token, ".") {
		t.Fatalf("token = %q", media.Token)
	}
}

func TestMintEndpointPlaceholderWithoutKeys(t *testing.T) {
	srv := testServer(t, livekit.Credentials{})
	res := postJSON(t, srv, "/media/tokens", `{"sessionId":"abc-1","role":"agent"}`, "")
	if res.Code != http.StatusOK {
		t.Fatalf("status %d", res.Code)
	}
	var media livekit.ParticipantMedia
	if err := json.Unmarshal(res.Body.Bytes(), &media); err != nil {
		t.Fatal(err)
	}
	if media.LiveKitConfigured || media.Token != "lk-stub-agent-vkyc-abc-1" || media.RoomName != "vkyc-abc-1" {
		t.Fatalf("media = %+v", media)
	}
}

func TestMintEndpointRejectsBadRole(t *testing.T) {
	srv := testServer(t, livekit.Credentials{APIKey: "k", APISecret: "s"})
	res := postJSON(t, srv, "/media/tokens", `{"sessionId":"abc-1","role":"admin"}`, "")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status %d body %s", res.Code, res.Body.String())
	}
}

func TestHealth(t *testing.T) {
	srv := testServer(t, livekit.Credentials{})
	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func testServer(t *testing.T, creds livekit.Credentials) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	Register(mux, livekit.NewMinter(creds), DefaultOrigins())
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func postJSON(t *testing.T, srv *httptest.Server, path, body, origin string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	srv.Config.Handler.ServeHTTP(rec, req)
	return rec
}
