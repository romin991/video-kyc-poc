// Package config loads the company-stack API settings from the environment.
// A repo-root .env is applied only for variables that are not already set.
package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultPort           = "3001"
	defaultCustomerOrigin = "http://127.0.0.1:3002"
)

// Default CORS covers the Next.js shells and the reference Vite apps.
var defaultCORS = []string{
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"http://localhost:3002",
	"http://127.0.0.1:3002",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"http://localhost:5174",
	"http://127.0.0.1:5174",
}

// Config is the process configuration for the session API.
type Config struct {
	Addr               string
	CustomerOrigin     string
	CORSOrigins        []string
	LiveKitURL         string
	LiveKitAPIKey      string
	LiveKitAPISecret   string
	CRMWebhookURL      string
	DatalakeWebhookURL string
	DispositionLogPath string
}

// Load reads environment variables. Existing process values win over .env.
func Load() Config {
	loadDotEnv()
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = defaultPort
	}
	origin := strings.TrimRight(strings.TrimSpace(os.Getenv("CUSTOMER_APP_ORIGIN")), "/")
	if origin == "" {
		origin = defaultCustomerOrigin
	}
	return Config{
		Addr:               "127.0.0.1:" + port,
		CustomerOrigin:     origin,
		CORSOrigins:        readList(os.Getenv("CORS_ORIGINS"), defaultCORS),
		LiveKitURL:         strings.TrimSpace(os.Getenv("LIVEKIT_URL")),
		LiveKitAPIKey:      strings.TrimSpace(os.Getenv("LIVEKIT_API_KEY")),
		LiveKitAPISecret:   strings.TrimSpace(os.Getenv("LIVEKIT_API_SECRET")),
		CRMWebhookURL:      strings.TrimSpace(os.Getenv("CRM_STUB_WEBHOOK_URL")),
		DatalakeWebhookURL: strings.TrimSpace(os.Getenv("DATALAKE_STUB_WEBHOOK_URL")),
		DispositionLogPath: dispositionLogPath(os.Getenv("DISPOSITION_STUB_LOG_PATH")),
	}
}

func dispositionLogPath(value string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		raw = "data/disposition-stubs.jsonl"
	}
	if filepath.IsAbs(raw) {
		return raw
	}
	return filepath.Join(repoRoot(), raw)
}

func repoRoot() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	dir := cwd
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return cwd
}

func readList(value string, fallback []string) []string {
	if strings.TrimSpace(value) == "" {
		return append([]string(nil), fallback...)
	}
	var out []string
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			out = append(out, item)
		}
	}
	if len(out) == 0 {
		return append([]string(nil), fallback...)
	}
	return out
}

func loadDotEnv() {
	for _, path := range envCandidates() {
		applyEnvFile(path)
	}
}

func envCandidates() []string {
	cwd, err := os.Getwd()
	if err != nil {
		return nil
	}
	var paths []string
	dir := cwd
	for i := 0; i < 5; i++ {
		paths = append(paths, filepath.Join(dir, ".env"))
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return paths
}

func applyEnvFile(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		_ = os.Setenv(key, value)
	}
}
