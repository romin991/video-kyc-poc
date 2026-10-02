package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/romin991/video-kyc-poc/apps/go-api/internal/session"
)

const kindList = "face, id, selfie_ktp, or other"

var (
	digitPattern   = regexp.MustCompile(`^\d{4,6}$`)
	dataURLPattern = regexp.MustCompile(`(?i)^data:image/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$`)
	base64Pattern  = regexp.MustCompile(`^[A-Za-z0-9+/=\s]+$`)
)

func parsePatch(raw json.RawMessage) (session.Patch, string) {
	obj, message := parseObject(raw)
	if message != "" {
		return session.Patch{}, message
	}
	var patch session.Patch

	if value, ok := obj["checklist"]; ok {
		items, message := parseChecklist(value)
		if message != "" {
			return session.Patch{}, message
		}
		patch.HasChecklist = true
		patch.Checklist = items
	}
	if value, ok := obj["captureGuide"]; ok {
		guide, message := parseCaptureGuide(value)
		if message != "" {
			return session.Patch{}, message
		}
		patch.HasCaptureGuide = true
		patch.CaptureGuide = guide
	}
	if value, ok := obj["maPrompt"]; ok {
		prompt, message := parseMaPrompt(value)
		if message != "" {
			return session.Patch{}, message
		}
		patch.HasMaPrompt = true
		patch.MaPrompt = prompt
	}
	if value, ok := obj["digitChallenge"]; ok {
		digits, message := parseDigitChallenge(value)
		if message != "" {
			return session.Patch{}, message
		}
		patch.HasDigit = true
		patch.Digits = digits
	}
	if value, ok := obj["maMatch"]; ok {
		flag, message := parseMatchFlag(value, "maMatch")
		if message != "" {
			return session.Patch{}, message
		}
		patch.HasMaMatch = true
		patch.MaMatch = flag
	}
	if value, ok := obj["digitMatch"]; ok {
		flag, message := parseMatchFlag(value, "digitMatch")
		if message != "" {
			return session.Patch{}, message
		}
		patch.HasDigitMatch = true
		patch.DigitMatch = flag
	}
	return patch, ""
}

func parseReply(raw json.RawMessage) (session.Reply, string) {
	obj, message := parseObject(raw)
	if message != "" {
		return session.Reply{}, message
	}
	var reply session.Reply
	if value, ok := obj["answer"]; ok {
		answer, message := parseBoundedString(value, "answer", session.AnswerMaxChars)
		if message != "" {
			return session.Reply{}, message
		}
		reply.Answer = &answer
	}
	if value, ok := obj["digitResponse"]; ok {
		text, message := parseDigitResponse(value)
		if message != "" {
			return session.Reply{}, message
		}
		reply.DigitResponse = &text
	}
	if reply.Answer == nil && reply.DigitResponse == nil {
		return session.Reply{}, "answer or digitResponse is required"
	}
	return reply, ""
}

func parseObject(raw json.RawMessage) (map[string]json.RawMessage, string) {
	if len(raw) == 0 || raw[0] != '{' {
		return nil, "Body must be a JSON object"
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, "Body must be a JSON object"
	}
	return obj, ""
}

func parseChecklist(raw json.RawMessage) ([]session.ChecklistUpdate, string) {
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, "checklist must be an array"
	}
	items := make([]session.ChecklistUpdate, 0, len(entries))
	for _, entry := range entries {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(entry, &obj); err != nil || obj == nil {
			return nil, "Each checklist item needs an id"
		}
		idRaw, ok := obj["id"]
		if !ok {
			return nil, "Each checklist item needs an id"
		}
		var id string
		if err := json.Unmarshal(idRaw, &id); err != nil || strings.TrimSpace(id) == "" {
			return nil, "Each checklist item needs an id"
		}
		checkedRaw, ok := obj["checked"]
		if !ok {
			return nil, "checklist " + id + " needs checked: true or false"
		}
		var checked bool
		if err := json.Unmarshal(checkedRaw, &checked); err != nil {
			return nil, "checklist " + id + " needs checked: true or false"
		}
		items = append(items, session.ChecklistUpdate{ID: strings.TrimSpace(id), Checked: checked})
	}
	return items, ""
}

func parseCaptureGuide(raw json.RawMessage) (*session.CaptureKind, string) {
	if string(raw) == "null" {
		return nil, ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil || strings.TrimSpace(text) == "" {
		return nil, "captureGuide must be " + kindList + ", or null"
	}
	kind, ok := parseKind(text)
	if !ok {
		return nil, "captureGuide must be " + kindList + ", or null"
	}
	return &kind, ""
}

func parseMaPrompt(raw json.RawMessage) (*session.MaPromptInput, string) {
	if string(raw) == "null" {
		return nil, ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, "maPrompt must be an object or null"
	}
	fieldRaw, ok := obj["field"]
	var fieldText string
	if !ok || json.Unmarshal(fieldRaw, &fieldText) != nil || strings.TrimSpace(fieldText) == "" {
		return nil, "maPrompt.field must be full_name, dob, or mothers_maiden_name"
	}
	field, ok := parseMaField(fieldText)
	if !ok {
		return nil, "maPrompt.field must be full_name, dob, or mothers_maiden_name"
	}
	prompt := session.DefaultPrompt(field)
	if custom, ok := obj["prompt"]; ok {
		var text string
		if err := json.Unmarshal(custom, &text); err != nil {
			return nil, "maPrompt.prompt must be a string"
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return nil, "maPrompt.prompt must not be empty"
		}
		if len(text) > session.PromptMaxChars {
			return nil, "maPrompt.prompt must be 240 characters or fewer"
		}
		prompt = text
	}
	return &session.MaPromptInput{Field: field, Prompt: prompt}, ""
}

func parseDigitChallenge(raw json.RawMessage) (*string, string) {
	if string(raw) == "null" {
		return nil, ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, "digitChallenge must be an object or null"
	}
	digitsRaw, ok := obj["digits"]
	var text string
	if !ok || json.Unmarshal(digitsRaw, &text) != nil {
		return nil, "digitChallenge.digits must be a string"
	}
	digits := strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, text)
	if !digitPattern.MatchString(digits) {
		return nil, "digitChallenge.digits must be 4 to 6 digits"
	}
	return &digits, ""
}

func parseMatchFlag(raw json.RawMessage, label string) (*bool, string) {
	if string(raw) == "null" {
		return nil, ""
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, label + " must be true, false, or null"
	}
	return &value, ""
}

func parseBoundedString(raw json.RawMessage, label string, max int) (string, string) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", label + " must be a string"
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", label + " must not be empty"
	}
	if len(text) > max {
		return "", label + " must be " + strconv.Itoa(max) + " characters or fewer"
	}
	return text, ""
}

func parseDigitResponse(raw json.RawMessage) (string, string) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", "digitResponse must be a string"
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", "digitResponse must not be empty"
	}
	if len(text) > session.DigitResponseMaxChars {
		return "", "digitResponse must be 16 characters or fewer"
	}
	for _, r := range text {
		if (r < '0' || r > '9') && r != ' ' {
			return "", "digitResponse must be digits"
		}
	}
	return text, ""
}

func parseCaptureMeta(raw map[string]json.RawMessage, now time.Time) (session.CaptureKind, time.Time, string) {
	kind := session.KindOther
	if value, ok := raw["kind"]; ok && string(value) != "null" && string(value) != `""` {
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			return "", time.Time{}, "kind must be " + kindList
		}
		if strings.TrimSpace(text) != "" {
			parsed, ok := parseKind(text)
			if !ok {
				return "", time.Time{}, "kind must be " + kindList
			}
			kind = parsed
		}
	}
	capturedAt := now.UTC()
	if value, ok := raw["capturedAt"]; ok && string(value) != "null" && string(value) != `""` {
		var text string
		if err := json.Unmarshal(value, &text); err != nil || strings.TrimSpace(text) == "" {
			return "", time.Time{}, "capturedAt must be an ISO-8601 date string"
		}
		parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(text))
		if err != nil {
			parsed, err = time.Parse(time.RFC3339, strings.TrimSpace(text))
		}
		if err != nil {
			return "", time.Time{}, "capturedAt must be an ISO-8601 date string"
		}
		capturedAt = parsed.UTC()
	}
	return kind, capturedAt, ""
}

func parseKind(value string) (session.CaptureKind, bool) {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	switch trimmed {
	case "face":
		return session.KindFace, true
	case "id":
		return session.KindID, true
	case "selfie_ktp", "selfie-ktp", "selfie+ktp", "selfiektp":
		return session.KindSelfieKTP, true
	case "other", "doc", "extra_doc", "extra-doc", "extradoc":
		return session.KindOther, true
	}
	compact := strings.Map(func(r rune) rune {
		switch r {
		case ' ', '_', '+', '-':
			return -1
		default:
			return r
		}
	}, trimmed)
	switch compact {
	case "selfiektp":
		return session.KindSelfieKTP, true
	case "extradoc":
		return session.KindOther, true
	default:
		return "", false
	}
}

func parseMaField(value string) (session.MaField, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "full_name":
		return session.FieldFullName, true
	case "dob":
		return session.FieldDOB, true
	case "mothers_maiden_name":
		return session.FieldMothersMaidenName, true
	default:
		return "", false
	}
}

func decodeImage(text string) (string, []byte, int, string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", nil, 400, "image is required"
	}
	payload := text
	if match := dataURLPattern.FindStringSubmatch(text); match != nil {
		payload = match[1]
	} else if !base64Pattern.MatchString(text) {
		return "", nil, 400, "image must be a JPEG/PNG file, a data URL, or base64"
	}
	payload = strings.Join(strings.Fields(payload), "")
	bytes, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		bytes, err = base64.RawStdEncoding.DecodeString(payload)
	}
	if err != nil || len(bytes) == 0 {
		return "", nil, 400, "image is required"
	}
	if len(bytes) > session.ImageMaxBytes {
		return "", nil, 413, "Image must be 4 MB or smaller"
	}
	contentType := sniffImage(bytes)
	if contentType == "" {
		return "", nil, 400, "Image must be JPEG or PNG"
	}
	return contentType, bytes, 200, ""
}

func sniffImage(bytes []byte) string {
	if len(bytes) >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
		return "image/jpeg"
	}
	if len(bytes) >= 8 &&
		bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e && bytes[3] == 0x47 &&
		bytes[4] == 0x0d && bytes[5] == 0x0a && bytes[6] == 0x1a && bytes[7] == 0x0a {
		return "image/png"
	}
	return ""
}
