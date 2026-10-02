package session

import "strings"
import "time"

// CaptureKind is the still the desk asked for.
// id is the only kind that turns the customer card guide on.
type CaptureKind string

const (
	KindFace      CaptureKind = "face"
	KindID        CaptureKind = "id"
	KindSelfieKTP CaptureKind = "selfie_ktp"
	KindOther     CaptureKind = "other"
)

// MaField is one manual-auth question.
type MaField string

const (
	FieldFullName          MaField = "full_name"
	FieldDOB               MaField = "dob"
	FieldMothersMaidenName MaField = "mothers_maiden_name"
)

const (
	PromptMaxChars        = 240
	AnswerMaxChars        = 200
	DigitResponseMaxChars = 16
	CaptureMaxCount       = 20
	ImageMaxBytes         = 4 * 1024 * 1024
)

// MaPrompt is the question currently on the customer screen.
type MaPrompt struct {
	Field  MaField
	Prompt string
	SentAt time.Time
}

// MaAnswer is one stored reply. A later reply for the same field replaces it.
type MaAnswer struct {
	Field      MaField
	Prompt     string
	Answer     string
	AnsweredAt time.Time
}

// DigitChallenge is the liveness prompt currently on the customer screen.
type DigitChallenge struct {
	Digits string
	Prompt string
	SentAt time.Time
}

// ChecklistItem is one thin desk tick.
type ChecklistItem struct {
	ID      string
	Label   string
	Checked bool
}

// Capture is still metadata. The JPEG or PNG bytes are stored beside the session.
type Capture struct {
	ID          string
	Kind        CaptureKind
	ContentType string
	CreatedAt   time.Time
	CapturedAt  time.Time
}

// MaPromptInput is a validated question before the server stamps sentAt.
type MaPromptInput struct {
	Field  MaField
	Prompt string
}

// Patch is a validated desk update. Absent flags leave the session alone.
// A present nil clears that value.
type Patch struct {
	HasChecklist    bool
	Checklist       []ChecklistUpdate
	HasCaptureGuide bool
	CaptureGuide    *CaptureKind
	HasMaPrompt     bool
	MaPrompt        *MaPromptInput
	HasDigit        bool
	Digits          *string
	HasMaMatch      bool
	MaMatch         *bool
	HasDigitMatch   bool
	DigitMatch      *bool
}

// ChecklistUpdate sets one known item.
type ChecklistUpdate struct {
	ID      string
	Checked bool
}

// Reply is a customer answer, a digit reply, or both.
type Reply struct {
	Answer        *string
	DigitResponse *string
}

// Default prompts. A desk may replace the text; the field stays one of these three.
func DefaultPrompt(field MaField) string {
	switch field {
	case FieldFullName:
		return "Please type your full name."
	case FieldDOB:
		return "Please type your date of birth."
	case FieldMothersMaidenName:
		return "Please type your mother's maiden name."
	default:
		return ""
	}
}

// DigitPrompt is the sentence shown with the numerals spaced out.
func DigitPrompt(digits string) string {
	parts := make([]string, len(digits))
	for i, r := range digits {
		parts[i] = string(r)
	}
	return "Please say these digits, then type them here: " + strings.Join(parts, " ")
}

func defaultChecklist() []ChecklistItem {
	return []ChecklistItem{
		{ID: "identity_match", Label: "Identity match", Checked: false},
		{ID: "liveness_digits", Label: "Liveness digits spoken", Checked: false},
		{ID: "docs_shown", Label: "Documents shown", Checked: false},
	}
}

func setChecklist(items []ChecklistItem, id string, checked bool) {
	for i := range items {
		if items[i].ID == id {
			items[i].Checked = checked
			return
		}
	}
}

func tickChecklist(items []ChecklistItem, id string) {
	setChecklist(items, id, true)
}

// ShowsDocs is true for ID, selfie+KTP, and extra-doc stills. A face still does not count.
func ShowsDocs(kind CaptureKind) bool {
	return kind == KindID || kind == KindSelfieKTP || kind == KindOther
}
