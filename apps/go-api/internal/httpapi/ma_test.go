package httpapi

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"

	"github.com/romin991/video-kyc-poc/apps/go-api/internal/session"
)

const tinyJPEG = "/9j/2Q=="

func openCall(t *testing.T, base string) (id, token string) {
	t.Helper()
	status, created := do(t, base, http.MethodPost, "/sessions", "{}", nil)
	if status != http.StatusCreated {
		t.Fatalf("create = %d", status)
	}
	id = created["id"].(string)
	token = created["joinToken"].(string)
	code, _ := do(t, base, http.MethodPost, "/sessions/"+id+"/accept", "", nil)
	if code != http.StatusOK {
		t.Fatalf("accept = %d", code)
	}
	return id, token
}

func checklistChecked(t *testing.T, body map[string]any, id string) bool {
	t.Helper()
	items, ok := body["checklist"].([]any)
	if !ok {
		t.Fatalf("checklist = %#v", body["checklist"])
	}
	for _, item := range items {
		row := item.(map[string]any)
		if row["id"] == id {
			return row["checked"] == true
		}
	}
	t.Fatalf("missing checklist %s", id)
	return false
}

func TestManualAuthPromptsDigitsAndStubMatch(t *testing.T) {
	srv := newTestServer(t, nil)
	defer srv.Close()

	status, created := do(t, srv.URL, http.MethodPost, "/sessions", "{}", nil)
	if status != http.StatusCreated {
		t.Fatalf("create = %d", status)
	}
	if created["maPrompt"] != nil || created["digitChallenge"] != nil || created["digitResponse"] != nil {
		t.Fatalf("fresh prompts = %#v", created)
	}
	if created["maMatch"] != nil || created["digitMatch"] != nil || created["digitRespondedAt"] != nil {
		t.Fatalf("fresh match = %#v", created)
	}
	answers, ok := created["maAnswers"].([]any)
	if !ok || len(answers) != 0 {
		t.Fatalf("maAnswers = %#v", created["maAnswers"])
	}
	if checklistChecked(t, created, "identity_match") || checklistChecked(t, created, "liveness_digits") || checklistChecked(t, created, "docs_shown") {
		t.Fatal("fresh checklist was checked")
	}

	id := created["id"].(string)
	token := created["joinToken"].(string)
	early, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"answer":"too early"}`, nil)
	if early != http.StatusConflict {
		t.Fatalf("waiting reply = %d", early)
	}

	if code, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/accept", "", nil); code != http.StatusOK {
		t.Fatalf("accept = %d", code)
	}

	askedCode, asked := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"maPrompt":{"field":"full_name"}}`, nil)
	if askedCode != http.StatusOK {
		t.Fatalf("ask = %d %#v", askedCode, asked)
	}
	prompt := asked["maPrompt"].(map[string]any)
	if prompt["field"] != "full_name" || !strings.Contains(strings.ToLower(prompt["prompt"].(string)), "full name") {
		t.Fatalf("prompt = %#v", prompt)
	}
	if !strings.HasSuffix(prompt["sentAt"].(string), "Z") {
		t.Fatalf("sentAt = %v", prompt["sentAt"])
	}

	_, join := do(t, srv.URL, http.MethodGet, "/join/"+token, "", nil)
	if join["maPrompt"].(map[string]any)["field"] != "full_name" || join["digitChallenge"] != nil {
		t.Fatalf("join prompt = %#v", join)
	}
	missing, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{}`, nil)
	if missing != http.StatusBadRequest {
		t.Fatalf("empty reply = %d", missing)
	}

	answeredCode, answered := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"answer":"  Ayu Prameswari  "}`, nil)
	if answeredCode != http.StatusOK || answered["ok"] != true || answered["maPrompt"] != nil {
		t.Fatalf("answer %d %#v", answeredCode, answered)
	}
	_, logged := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	loggedAnswers := logged["maAnswers"].([]any)
	if len(loggedAnswers) != 1 || loggedAnswers[0].(map[string]any)["answer"] != "Ayu Prameswari" || logged["maPrompt"] != nil {
		t.Fatalf("logged = %#v", logged["maAnswers"])
	}

	if code, _ := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"maPrompt":{"field":"dob"}}`, nil); code != http.StatusOK {
		t.Fatalf("dob = %d", code)
	}
	if code, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"answer":"1994-03-15"}`, nil); code != http.StatusOK {
		t.Fatalf("dob reply = %d", code)
	}
	maidenCode, maiden := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"maPrompt":{"field":"mothers_maiden_name","prompt":"Mother's maiden name, please."}}`, nil)
	if maidenCode != http.StatusOK || maiden["maPrompt"].(map[string]any)["prompt"] != "Mother's maiden name, please." {
		t.Fatalf("maiden %d %#v", maidenCode, maiden["maPrompt"])
	}
	if code, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"answer":"Wijaya"}`, nil); code != http.StatusOK {
		t.Fatalf("maiden reply = %d", code)
	}

	_, both := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	fields := both["maAnswers"].([]any)
	if len(fields) != 3 || fields[2].(map[string]any)["answer"] != "Wijaya" {
		t.Fatalf("answers = %#v", fields)
	}

	if code, _ := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"maPrompt":{"field":"dob"}}`, nil); code != http.StatusOK {
		t.Fatal("reask")
	}
	if code, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"answer":"1-1-1"}`, nil); code != http.StatusOK {
		t.Fatal("replace")
	}
	_, replaced := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	replacedAnswers := replaced["maAnswers"].([]any)
	if len(replacedAnswers) != 3 {
		t.Fatalf("replaced len = %d", len(replacedAnswers))
	}
	got := map[string]string{}
	order := make([]string, 0, 3)
	for _, item := range replacedAnswers {
		row := item.(map[string]any)
		field := row["field"].(string)
		order = append(order, field)
		got[field] = row["answer"].(string)
	}
	if strings.Join(order, ",") != "full_name,dob,mothers_maiden_name" {
		t.Fatalf("order = %v", order)
	}
	if got["dob"] != "1-1-1" || got["full_name"] != "Ayu Prameswari" || got["mothers_maiden_name"] != "Wijaya" {
		t.Fatalf("replaced = %#v", got)
	}
	if checklistChecked(t, replaced, "identity_match") {
		t.Fatal("reask checked identity")
	}

	digitsCode, digits := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"digitChallenge":{"digits":"48 21"}}`, nil)
	if digitsCode != http.StatusOK {
		t.Fatalf("digits = %d %#v", digitsCode, digits)
	}
	challenge := digits["digitChallenge"].(map[string]any)
	if challenge["digits"] != "4821" || !strings.Contains(challenge["prompt"].(string), "4 8 2 1") {
		t.Fatalf("challenge = %#v", challenge)
	}
	_, digitJoin := do(t, srv.URL, http.MethodGet, "/join/"+token, "", nil)
	if digitJoin["digitChallenge"].(map[string]any)["digits"] != "4821" {
		t.Fatalf("digit join = %#v", digitJoin["digitChallenge"])
	}
	spokenCode, spoken := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"digitResponse":"4 8 2 1"}`, nil)
	if spokenCode != http.StatusOK || spoken["digitChallenge"] != nil {
		t.Fatalf("spoken %d %#v", spokenCode, spoken)
	}
	_, afterDigits := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	if afterDigits["digitResponse"] != "4 8 2 1" || afterDigits["digitChallenge"] != nil || afterDigits["digitRespondedAt"] == nil {
		t.Fatalf("after digits = %#v", afterDigits)
	}
	if !checklistChecked(t, afterDigits, "liveness_digits") || checklistChecked(t, afterDigits, "identity_match") {
		t.Fatal("digit checklist")
	}

	passedCode, passed := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"maMatch":true,"digitMatch":false}`, nil)
	if passedCode != http.StatusOK || passed["maMatch"] != true || passed["digitMatch"] != false {
		t.Fatalf("passed %d %#v", passedCode, passed)
	}
	if !checklistChecked(t, passed, "identity_match") || !checklistChecked(t, passed, "liveness_digits") {
		t.Fatal("pass ticks")
	}
	_, failed := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"maMatch":false}`, nil)
	if failed["maMatch"] != false || checklistChecked(t, failed, "identity_match") || !checklistChecked(t, failed, "liveness_digits") {
		t.Fatal("fail untick")
	}

	_, again := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"digitChallenge":{"digits":"1357"}}`, nil)
	if again["digitResponse"] != nil || again["digitChallenge"].(map[string]any)["digits"] != "1357" {
		t.Fatalf("again = %#v", again)
	}
	badField, _ := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"maPrompt":{"field":"nik"}}`, nil)
	if badField != http.StatusBadRequest {
		t.Fatalf("bad field = %d", badField)
	}
	badDigits, _ := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"digitChallenge":{"digits":"12"}}`, nil)
	if badDigits != http.StatusBadRequest {
		t.Fatalf("bad digits = %d", badDigits)
	}
	_, still := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	if still["digitChallenge"].(map[string]any)["digits"] != "1357" {
		t.Fatalf("unchanged = %#v", still["digitChallenge"])
	}
}

func TestCaptureKindsTickDocuments(t *testing.T) {
	srv := newTestServer(t, nil)
	defer srv.Close()
	id, token := openCall(t, srv.URL)

	faceCode, face := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/captures", `{"image":"`+tinyJPEG+`","kind":"face"}`, nil)
	if faceCode != http.StatusCreated || face["kind"] != "face" {
		t.Fatalf("face %d %#v", faceCode, face)
	}
	_, afterFace := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	if checklistChecked(t, afterFace, "docs_shown") {
		t.Fatal("face ticked documents")
	}

	selfieCode, selfie := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/captures", `{"image":"`+tinyJPEG+`","kind":"selfie+ktp"}`, nil)
	if selfieCode != http.StatusCreated || selfie["kind"] != "selfie_ktp" {
		t.Fatalf("selfie %d %#v", selfieCode, selfie)
	}
	extraCode, extra := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/captures", `{"image":"`+tinyJPEG+`","kind":"doc"}`, nil)
	if extraCode != http.StatusCreated || extra["kind"] != "other" {
		t.Fatalf("extra %d %#v", extraCode, extra)
	}

	guideCode, guide := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"captureGuide":"selfie_ktp"}`, nil)
	if guideCode != http.StatusOK || guide["captureGuide"] != "selfie_ktp" {
		t.Fatalf("guide %d %#v", guideCode, guide["captureGuide"])
	}
	_, joined := do(t, srv.URL, http.MethodGet, "/join/"+token, "", nil)
	if joined["captureGuide"] != "selfie_ktp" {
		t.Fatalf("join guide = %#v", joined["captureGuide"])
	}
	_, idGuide := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"captureGuide":"id"}`, nil)
	if idGuide["captureGuide"] != "id" {
		t.Fatalf("id guide = %#v", idGuide["captureGuide"])
	}
	_, idJoin := do(t, srv.URL, http.MethodGet, "/join/"+token, "", nil)
	if idJoin["captureGuide"] != "id" {
		t.Fatalf("id join = %#v", idJoin["captureGuide"])
	}

	_, docs := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	kinds := docs["captures"].([]any)
	if len(kinds) != 3 {
		t.Fatalf("captures = %#v", kinds)
	}
	got := []string{kinds[0].(map[string]any)["kind"].(string), kinds[1].(map[string]any)["kind"].(string), kinds[2].(map[string]any)["kind"].(string)}
	if strings.Join(got, ",") != "face,selfie_ktp,other" {
		t.Fatalf("kinds = %v", got)
	}
	if !checklistChecked(t, docs, "docs_shown") {
		t.Fatal("documents not ticked")
	}
	path := kinds[0].(map[string]any)["path"].(string)
	req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("capture bytes %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}

	unknown, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/captures", `{"image":"`+tinyJPEG+`","kind":"escalate"}`, nil)
	if unknown != http.StatusBadRequest {
		t.Fatalf("unknown kind = %d", unknown)
	}
}

func TestReplyWithoutPromptIsRejected(t *testing.T) {
	srv := newTestServer(t, nil)
	defer srv.Close()
	id, token := openCall(t, srv.URL)

	answer, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"answer":"Ayu"}`, nil)
	if answer != http.StatusConflict {
		t.Fatalf("answer = %d", answer)
	}
	digits, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"digitResponse":"1234"}`, nil)
	if digits != http.StatusConflict {
		t.Fatalf("digits = %d", digits)
	}
	if code, _ := do(t, srv.URL, http.MethodPatch, "/sessions/"+id, `{"digitChallenge":{"digits":"1234"}}`, nil); code != http.StatusOK {
		t.Fatal("challenge")
	}
	bad, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"digitResponse":"four"}`, nil)
	if bad != http.StatusBadRequest {
		t.Fatalf("letters = %d", bad)
	}
	_, still := do(t, srv.URL, http.MethodGet, "/sessions/"+id, "", nil)
	if still["digitResponse"] != nil {
		t.Fatalf("stored letters %#v", still["digitResponse"])
	}
	if code, _ := do(t, srv.URL, http.MethodPost, "/sessions/"+id+"/end", "", nil); code != http.StatusOK {
		t.Fatal("end")
	}
	late, _ := do(t, srv.URL, http.MethodPost, "/join/"+token+"/replies", `{"digitResponse":"1234"}`, nil)
	if late != http.StatusConflict {
		t.Fatalf("late = %d", late)
	}
}

func TestDecodeImage(t *testing.T) {
	contentType, blob, status, message := decodeImage("data:image/jpeg;base64," + tinyJPEG)
	if status != http.StatusOK || contentType != "image/jpeg" || len(blob) != 4 || message != "" {
		t.Fatalf("data url %d %s %d %s", status, contentType, len(blob), message)
	}
	if _, _, status, message = decodeImage("not-an-image"); status != http.StatusBadRequest || message != "image must be a JPEG/PNG file, a data URL, or base64" {
		t.Fatalf("garbage %d %s", status, message)
	}
	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	if contentType, _, status, _ = decodeImage(base64.StdEncoding.EncodeToString(png)); status != http.StatusOK || contentType != "image/png" {
		t.Fatalf("png %d %s", status, contentType)
	}
	over := base64.StdEncoding.EncodeToString(make([]byte, session.ImageMaxBytes+1))
	if _, _, status, message = decodeImage(over); status != http.StatusRequestEntityTooLarge || message != "Image must be 4 MB or smaller" {
		t.Fatalf("oversize %d %s", status, message)
	}
}
