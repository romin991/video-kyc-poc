package envfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAppliesNearestEnvWithoutOverride(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "services", "vkyc-api")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	contents := "LIVEKIT_URL=wss://from-file.livekit.cloud\nLIVEKIT_API_KEY=from-file\nexport LIVEKIT_API_SECRET=\"quoted secret\"\n# comment\n\n"
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("LIVEKIT_API_KEY", "already-set")
	t.Setenv("LIVEKIT_URL", "")
	t.Setenv("LIVEKIT_API_SECRET", "")

	Load(nested)

	if got := os.Getenv("LIVEKIT_URL"); got != "wss://from-file.livekit.cloud" {
		t.Fatalf("LIVEKIT_URL = %q", got)
	}
	if got := os.Getenv("LIVEKIT_API_KEY"); got != "already-set" {
		t.Fatalf("existing key was overridden: %q", got)
	}
	if got := os.Getenv("LIVEKIT_API_SECRET"); got != "quoted secret" {
		t.Fatalf("LIVEKIT_API_SECRET = %q", got)
	}
}
