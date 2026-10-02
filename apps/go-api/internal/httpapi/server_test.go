package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/romin991/video-kyc-poc/apps/go-api/internal/config"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/livekit"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/session"
)

func testConfig() config.Config {
	return config.Config{
		CustomerOrigin: "http://127.0.0.1:3002",
		CORSOrigins: []string{
			"http://127.0.0.1:3000",
			"http://127.0.0.1:3002",
		},
		LiveKitURL: "wss://example.livekit.cloud",
	}
}

func newTestServer(t *testing.T, minter livekit.Minter) *httptest.Server {
	t.Helper()
	if minter == nil {
		minter = livekit.New("", "")
	}
	return httptest.NewServer(New(session.NewStore(), testConfig(), minter))
}

func do(t *testing.T, base, method, path, body string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, base+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return res.StatusCode, nil
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("status %d body %s: %v", res.StatusCode, raw, err)
	}
	return res.StatusCode, decoded
}

func TestLifecycleCreateJoinClaimEnd(t *testing.T) {
	srv := newTestServer(t, nil)
	defer srv.Close()

	status, created := do(t, srv.URL, http.MethodPost, "/sessions", "{}", map[string]string{
		"X-Demo-Agent": "Desk 1",
	})
	if status != http.StatusCreated {
		t.Fatalf("create status = %d", status)
	}
	if created["status"] != "waiting" || created["createdBy"] != "Desk 1" || created["claimedBy"] != nil {
		t.Fatalf("created = %#v", created)
	}
	if _, ok := created["agentToken"]; ok {
		t.Fatal("create leaked an agent token")
	}
	if _, ok := created["customerToken"]; ok {
		t.Fatal("create leaked a customer token")
	}
	id := created["id"].(string)
	joinToken := created["joinToken"].(string)
	room := created["roomName"].(string)
	if joinToken == id {
		t.Fatal("join token matched the session id")
	}
	if room != "vkyc-"+id {
		t.Fatalf("room = %s", room)
	}
	if created["queuePosition"] != float64(1) {
		t.Fatalf("queuePosition = %v", created["queuePosition"])
	}
	joinURL, _ := created["joinUrl"].(string)
	if !strings.HasPrefix(joinURL, "http://127.0.0.1:3002/join/") {
		t.Fatalf("joinUrl = %s", joinURL)
	}

	_, queue := do(t, srv.URL, http.MethodGet, "/sessions?status=waiting", "", nil)
	sessions := queue["sessions"].([]any)
	if len(sessions) != 1 || sessions[0].(map[string]any)["id"] != id {
		t.Fatalf("queue = %#v", queue)
	}

	_, waiting := do(t, srv.URL, http.MethodGet, "/join/"+joinToken, "", nil)
	if waiting["status"] != "waiting" || waiting["roomName"] != room {
		t.Fatalf("join = %#v", waiting)
	}
	if waiting["customerToken"] != "lk-stub-customer-"+room {
		t.Fatalf("customer token = %v", waiting["customerToken"])
	}
	if waiting["livekitUrl"] != "wss://example.livekit.cloud" {
		t.Fatalf("livekitUrl = %v", waiting["livekitUrl"])
	}

	code, accepted := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/accept", "", nil)
	if code != http.StatusOK || accepted["status"] != "in_call" || accepted["claimedBy"] != "Demo agent" {
		t.Fatalf("accept %d %#v", code, accepted)
	}
	if accepted["agentToken"] != "lk-stub-agent-"+room || accepted["roomName"] != room {
		t.Fatalf("accept token = %#v", accepted)
	}

	conflict, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/accept", "", nil)
	if conflict != http.StatusConflict {
		t.Fatalf("second accept = %d", conflict)
	}

	_, live := do(t, srv.URL, http.MethodGet, "/join/"+joinToken, "", nil)
	if live["status"] != "in_call" || live["queuePosition"] != nil {
		t.Fatalf("live join = %#v", live)
	}
	if live["customerToken"] != "lk-stub-customer-"+room {
		t.Fatalf("live token = %v", live["customerToken"])
	}

	endCode, ended := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/end", "", nil)
	if endCode != http.StatusOK || ended["status"] != "ended" || ended["sessionId"] != id {
		t.Fatalf("end %d %#v", endCode, ended)
	}
	_, endedAgain := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/end", "", nil)
	if endedAgain["status"] != "ended" {
		t.Fatalf("second end = %#v", endedAgain)
	}
	_, after := do(t, srv.URL, http.MethodGet, "/join/"+joinToken, "", nil)
	if after["status"] != "ended" {
		t.Fatalf("join after end = %#v", after)
	}
	_, waitingAfter := do(t, srv.URL, http.MethodGet, "/sessions?status=waiting", "", nil)
	if len(waitingAfter["sessions"].([]any)) != 0 {
		t.Fatalf("waiting after end = %#v", waitingAfter)
	}
}

func TestClaimKeepsTheOtherSessionWaiting(t *testing.T) {
	srv := newTestServer(t, nil)
	defer srv.Close()

	_, first := do(t, srv.URL, http.MethodPost, "/sessions", "{}", map[string]string{"X-Demo-Agent": "Customer"})
	_, second := do(t, srv.URL, http.MethodPost, "/sessions", "{}", map[string]string{"X-Demo-Agent": "Customer"})
	firstID := first["id"].(string)
	secondID := second["id"].(string)
	if first["queuePosition"] != float64(1) || second["queuePosition"] != float64(2) {
		t.Fatalf("positions %#v %#v", first["queuePosition"], second["queuePosition"])
	}

	code, claimed := do(t, srv.URL, http.MethodPost, "/sessions/claim", "", map[string]string{"X-Demo-Agent": "Desk 1"})
	if code != http.StatusOK || claimed["sessionId"] != firstID || claimed["claimedBy"] != "Desk 1" {
		t.Fatalf("claim %d %#v", code, claimed)
	}
	if !strings.HasPrefix(claimed["agentToken"].(string), "lk-stub-agent-vkyc-") {
		t.Fatalf("agent token = %v", claimed["agentToken"])
	}

	again, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+firstID+"/accept", "", nil)
	if again != http.StatusConflict {
		t.Fatalf("accept claimed = %d", again)
	}

	_, remaining := do(t, srv.URL, http.MethodGet, "/sessions?status=waiting", "", nil)
	rows := remaining["sessions"].([]any)
	if len(rows) != 1 {
		t.Fatalf("remaining = %#v", remaining)
	}
	row := rows[0].(map[string]any)
	if row["id"] != secondID || row["queuePosition"] != float64(1) || row["status"] != "waiting" {
		t.Fatalf("remaining row = %#v", row)
	}

	_, got := do(t, srv.URL, http.MethodGet, "/sessions/"+firstID, "", nil)
	if got["status"] != "in_call" || got["queuePosition"] != nil || got["roomName"] != "vkyc-"+firstID {
		t.Fatalf("in-call session = %#v", got)
	}
}

func TestErrorsAndCORS(t *testing.T) {
	srv := newTestServer(t, nil)
	defer srv.Close()

	missing, _ := do(t, srv.URL, http.MethodPost, "/sessions/does-not-exist/accept", "", nil)
	if missing != http.StatusNotFound {
		t.Fatalf("missing accept = %d", missing)
	}
	bad, _ := do(t, srv.URL, http.MethodGet, "/sessions?status=nope", "", nil)
	if bad != http.StatusBadRequest {
		t.Fatalf("bad filter = %d", bad)
	}
	missingJoin, _ := do(t, srv.URL, http.MethodGet, "/join/not-a-real-token", "", nil)
	if missingJoin != http.StatusNotFound {
		t.Fatalf("missing join = %d", missingJoin)
	}
	missingRoute, missingBody := do(t, srv.URL, http.MethodGet, "/nope", "", nil)
	if missingRoute != http.StatusNotFound || missingBody["error"] != "not_found" {
		t.Fatalf("missing route %d %#v", missingRoute, missingBody)
	}
	healthCode, health := do(t, srv.URL, http.MethodGet, "/health", "", nil)
	if healthCode != http.StatusOK || health["ok"] != true || health["service"] != "vkyc-api" || health["stack"] != "go" {
		t.Fatalf("health %d %#v", healthCode, health)
	}

	emptyClaim, _ := do(t, srv.URL, http.MethodPost, "/sessions/claim", "", nil)
	if emptyClaim != http.StatusConflict {
		t.Fatalf("empty claim = %d", emptyClaim)
	}
	badJSON, _ := do(t, srv.URL, http.MethodPost, "/sessions", "{", nil)
	if badJSON != http.StatusBadRequest {
		t.Fatalf("bad json = %d", badJSON)
	}

	createdCode, created := do(t, srv.URL, http.MethodPost, "/sessions", "", nil)
	if createdCode != http.StatusCreated {
		t.Fatalf("empty body create = %d", createdCode)
	}
	id := created["id"].(string)
	token := created["joinToken"].(string)
	endCode, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/end", "", nil)
	if endCode != http.StatusOK {
		t.Fatalf("end waiting = %d", endCode)
	}
	_, joined := do(t, srv.URL, http.MethodGet, "/join/"+token, "", nil)
	if joined["status"] != "ended" {
		t.Fatalf("join ended = %#v", joined)
	}
	acceptEnded, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/accept", "", nil)
	if acceptEnded != http.StatusConflict {
		t.Fatalf("accept ended = %d", acceptEnded)
	}

	req, err := http.NewRequest(http.MethodOptions, srv.URL+"/sessions", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "http://127.0.0.1:3000")
	req.Header.Set("Access-Control-Request-Method", "POST")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("options = %d", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:3000" {
		t.Fatalf("acao = %q", got)
	}
	if got := res.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(got, "X-Demo-Agent") {
		t.Fatalf("allow headers = %q", got)
	}

	req, err = http.NewRequest(http.MethodGet, srv.URL+"/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "https://evil.example")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unexpected acao %q", got)
	}
}

func TestAcceptMintsLiveKitJWT(t *testing.T) {
	minter := livekit.New("devkey", "secretsecretsecretsecretsecret12")
	srv := newTestServer(t, minter)
	defer srv.Close()

	_, created := do(t, srv.URL, http.MethodPost, "/sessions", "{}", nil)
	id := created["id"].(string)
	room := created["roomName"].(string)
	_, accepted := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/accept", "", map[string]string{
		"X-Demo-Agent": "Desk 1",
	})
	token := accepted["agentToken"].(string)
	if strings.HasPrefix(token, "lk-stub-") {
		t.Fatal("expected a real JWT")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token = %s", token)
	}
	if accepted["roomName"] != room {
		t.Fatalf("room = %v", accepted["roomName"])
	}

	_, joined := do(t, srv.URL, http.MethodGet, "/join/"+created["joinToken"].(string), "", nil)
	customer := joined["customerToken"].(string)
	if customer == token {
		t.Fatal("customer token matched the agent token")
	}
	again, _ := joined["customerToken"].(string)
	_, joinedAgain := do(t, srv.URL, http.MethodGet, "/join/"+created["joinToken"].(string), "", nil)
	if joinedAgain["customerToken"] != again {
		t.Fatal("customer poll did not reuse the cached token")
	}
}
