package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/romin991/video-kyc-poc/apps/go-api/internal/session"
)

func endAfterStill(t *testing.T, base, id string) {
	t.Helper()
	code, _ := do(t, base, http.MethodPost, "/sessions/"+id+"/captures", `{"image":"`+tinyJPEG+`","kind":"face"}`, nil)
	if code != http.StatusCreated {
		t.Fatalf("capture = %d", code)
	}
	code, _ = do(t, base, http.MethodPost, "/sessions/"+id+"/end", "", nil)
	if code != http.StatusOK {
		t.Fatalf("end = %d", code)
	}
}

func TestDispositionPersistsAfterEndAndStill(t *testing.T) {
	srv := newTestServer(t, nil)
	defer srv.Close()

	id, _ := openCall(t, srv.URL)
	early, earlyBody := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"disposition":"Approve"}`, nil)
	if early != http.StatusConflict || earlyBody["error"] != "conflict" {
		t.Fatalf("open call disposition = %d %#v", early, earlyBody)
	}

	code, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/end", "", nil)
	if code != http.StatusOK {
		t.Fatalf("end = %d", code)
	}
	missing, missingBody := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"disposition":"reject"}`, nil)
	if missing != http.StatusUnprocessableEntity || missingBody["error"] != "capture_required" {
		t.Fatalf("no still = %d %#v", missing, missingBody)
	}

	endAfterStill(t, srv.URL, id)
	for _, label := range []string{"Approve", "Reject", "UTV"} {
		savedCode, saved := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"disposition":"`+label+`","acwNotes":"Face still matches."}`, map[string]string{
			"X-Demo-Agent": "Desk 1",
		})
		if savedCode != http.StatusOK {
			t.Fatalf("%s = %d %#v", label, savedCode, saved)
		}
		want := strings.ToLower(label)
		if saved["disposition"] != want || saved["acwNotes"] != "Face still matches." {
			t.Fatalf("%s body = %#v", label, saved)
		}
	}

	_, again := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	if again["disposition"] != "utv" || again["acwNotes"] != "Face still matches." {
		t.Fatalf("refreshed = %#v", again)
	}
	captures := again["captures"].([]any)
	if len(captures) != 1 {
		t.Fatalf("captures = %#v", captures)
	}

	clearedCode, cleared := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"disposition":null}`, nil)
	if clearedCode != http.StatusOK || cleared["disposition"] != nil {
		t.Fatalf("clear = %d %#v", clearedCode, cleared)
	}
	notesCode, _ := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"acwNotes":"No second stub."}`, nil)
	if notesCode != http.StatusOK {
		t.Fatalf("notes = %d", notesCode)
	}

	_, evidence := do(t, srv.URL, http.MethodGet, "/disposition-stubs?sessionId="+id, "", nil)
	stubs := evidence["stubs"].([]any)
	if len(stubs) != 6 {
		t.Fatalf("stub count = %d %#v", len(stubs), evidence)
	}
	sinks := map[string]int{}
	for _, item := range stubs {
		row := item.(map[string]any)
		if row["disposition"] == nil || row["sessionId"] != id || row["agentId"] != "Desk 1" {
			t.Fatalf("stub = %#v", row)
		}
		sinks[row["sink"].(string)]++
		if _, ok := row["webhookError"]; ok {
			t.Fatalf("unexpected webhook error %#v", row)
		}
		recording := row["recording"].(map[string]any)
		if recording["url"] != nil || recording["id"] != nil {
			t.Fatalf("recording = %#v", recording)
		}
		shot := row["captures"].([]any)[0].(map[string]any)
		if shot["kind"] != "face" || shot["url"] == "" {
			t.Fatalf("capture = %#v", shot)
		}
	}
	if sinks["crm"] != 3 || sinks["datalake"] != 3 {
		t.Fatalf("sinks = %#v", sinks)
	}
}

func TestDispositionWebhooksAndLog(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, r.URL.Path+" "+string(body))
		mu.Unlock()
		if strings.Contains(r.URL.Path, "fail") {
			http.Error(w, "nope", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer hook.Close()

	logPath := t.TempDir() + "/disposition-stubs.jsonl"
	cfg := testConfig()
	cfg.CRMWebhookURL = hook.URL + "/crm"
	cfg.DatalakeWebhookURL = hook.URL + "/datalake"
	cfg.DispositionLogPath = logPath
	api := httptest.NewServer(New(session.NewStore(), cfg, nil))
	defer api.Close()

	id, _ := openCall(t, api.URL)
	endAfterStill(t, api.URL, id)
	code, saved := do(t, api.URL, http.MethodPost, "/sessions/"+id+"/recording", `{"recordingId":" EG_call ","recordingUrl":"https://egress.example/vkyc/call.mp4"}`, nil)
	if code != http.StatusOK || saved["recordingId"] != "EG_call" || saved["recordingUrl"] != "https://egress.example/vkyc/call.mp4" {
		t.Fatalf("attach = %d %#v", code, saved)
	}
	code, saved = do(t, api.URL, http.MethodPatch, "/sessions/"+id, `{"disposition":"approve"}`, map[string]string{
		"X-Demo-Agent": "Desk 1",
	})
	if code != http.StatusOK || saved["disposition"] != "approve" {
		t.Fatalf("disposition = %d %#v", code, saved)
	}
	mu.Lock()
	posted := append([]string(nil), seen...)
	mu.Unlock()
	if len(posted) != 2 {
		t.Fatalf("webhooks = %#v", posted)
	}
	for _, line := range posted {
		if !strings.Contains(line, `"disposition":"approve"`) || !strings.Contains(line, `"id":"EG_call"`) || !strings.Contains(line, "https://egress.example/vkyc/call.mp4") {
			t.Fatalf("posted = %s", line)
		}
	}

	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 {
		t.Fatalf("log lines = %#v", lines)
	}

	failCfg := testConfig()
	failCfg.CRMWebhookURL = hook.URL + "/fail-crm"
	failCfg.DatalakeWebhookURL = hook.URL + "/fail-datalake"
	failAPI := httptest.NewServer(New(session.NewStore(), failCfg, nil))
	defer failAPI.Close()
	failID, _ := openCall(t, failAPI.URL)
	endAfterStill(t, failAPI.URL, failID)
	code, saved = do(t, failAPI.URL, http.MethodPatch, "/sessions/"+failID, `{"disposition":"reject"}`, nil)
	if code != http.StatusOK || saved["disposition"] != "reject" {
		t.Fatalf("failed webhook disposition = %d %#v", code, saved)
	}
	_, evidence := do(t, failAPI.URL, http.MethodGet, "/disposition-stubs", "", nil)
	rows := evidence["stubs"].([]any)
	if len(rows) != 2 {
		t.Fatalf("failed evidence = %#v", evidence)
	}
	for _, item := range rows {
		if item.(map[string]any)["webhookError"] != "webhook returned 500" {
			t.Fatalf("fallback = %#v", item)
		}
	}
}

func TestRecordingAttachAndLocalWebM(t *testing.T) {
	srv := newTestServer(t, nil)
	defer srv.Close()

	id, _ := openCall(t, srv.URL)
	_, created := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	if created["recordingUrl"] != nil || created["recordingId"] != nil || created["recordingAttachedAt"] != nil || created["acwNotes"] != "" || created["disposition"] != nil {
		t.Fatalf("fresh recording = %#v", created)
	}

	missing, _ := do(t, srv.URL, http.MethodPost, "/sessions/missing/recording", `{"recordingId":"EG_missing"}`, nil)
	if missing != http.StatusNotFound {
		t.Fatalf("missing = %d", missing)
	}
	empty, emptyBody := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/recording", `{}`, nil)
	if empty != http.StatusBadRequest {
		t.Fatalf("empty = %d %#v", empty, emptyBody)
	}
	ftp, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/recording", `{"recordingUrl":"ftp://files.example/call.mp4"}`, nil)
	if ftp != http.StatusBadRequest {
		t.Fatalf("ftp = %d", ftp)
	}

	code, idOnly := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/recording", `{"recordingId":" EG_room_1 "}`, nil)
	if code != http.StatusOK || idOnly["recordingId"] != "EG_room_1" || idOnly["recordingUrl"] != nil {
		t.Fatalf("id only = %d %#v", code, idOnly)
	}
	code, attached := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/recording", `{"recordingUrl":"https://egress.example/vkyc/call.mp4"}`, nil)
	if code != http.StatusOK || attached["recordingUrl"] != "https://egress.example/vkyc/call.mp4" || attached["recordingId"] != "EG_room_1" {
		t.Fatalf("url = %d %#v", code, attached)
	}
	bad, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/recording", `{"recordingUrl":"not a url"}`, nil)
	if bad != http.StatusBadRequest {
		t.Fatalf("bad url = %d", bad)
	}

	longer := []byte("webm-call-bytes-0123456789")
	short := []byte("webm-short")
	first := postVideo(t, srv.URL, "/sessions/"+id+"/call-recording", "video/webm", longer)
	if first["recordingId"] == "" || !strings.HasPrefix(first["recordingId"].(string), "local_") {
		t.Fatalf("local id = %#v", first)
	}
	fileURL := first["recordingUrl"].(string)
	if !strings.HasSuffix(fileURL, "/sessions/"+id+"/call-recording/file.webm") {
		t.Fatalf("file url = %s", fileURL)
	}
	res, err := http.Get(fileURL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	got, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || string(got) != string(longer) || res.Header.Get("Content-Type") != "video/webm" {
		t.Fatalf("file = %d %q %s", res.StatusCode, got, res.Header.Get("Content-Type"))
	}

	kept := postVideo(t, srv.URL, "/sessions/"+id+"/call-recording", "video/webm", short)
	if kept["recordingId"] != first["recordingId"] {
		t.Fatalf("shorter replaced id %#v", kept)
	}
	res, err = http.Get(fileURL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	got, _ = io.ReadAll(res.Body)
	if string(got) != string(longer) {
		t.Fatalf("shorter replaced bytes %q", got)
	}

	part := postMultipartVideo(t, srv.URL, "/sessions/"+id+"/call-recording", append(longer, "-more"...))
	if part["recordingId"] != first["recordingId"] {
		t.Fatalf("multipart id = %#v", part)
	}
	_, listed := do(t, srv.URL, http.MethodGet, "/sessions/"+id+"/captures", "", nil)
	if _, ok := listed["captures"].([]any); !ok {
		t.Fatalf("captures list = %#v", listed)
	}
	_, sessionBody := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	if sessionBody["recordingUrl"] != part["recordingUrl"] {
		t.Fatalf("session recording = %#v", sessionBody["recordingUrl"])
	}
}

func postVideo(t *testing.T, base, path, contentType string, body []byte) map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload %d %s", res.StatusCode, raw)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func postMultipartVideo(t *testing.T, base, path string, body []byte) map[string]any {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="video"; filename="call.webm"`)
	header.Set("Content-Type", "video/webm")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, base+path, &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("multipart %d %s", res.StatusCode, raw)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}
