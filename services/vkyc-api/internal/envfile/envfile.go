// Package envfile loads a repo-root .env without overriding variables that
// are already set. It is intentionally small: KEY=value lines, optional
// export prefix, and matching single or double quotes.
package envfile

import (
	"os"
	"strings"
)

// Load walks from dir toward the filesystem root and applies the first .env
// it finds. Missing files are ignored. Existing environment variables win.
func Load(dir string) {
	current := dir
	for i := 0; i < 6; i++ {
		path := current + string(os.PathSeparator) + ".env"
		if data, err := os.ReadFile(path); err == nil {
			apply(string(data))
			return
		}
		parent := parentDir(current)
		if parent == current {
			return
		}
		current = parent
	}
}

func apply(contents string) {
	for _, line := range strings.Split(contents, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" || os.Getenv(key) != "" {
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

func parentDir(dir string) string {
	trimmed := strings.TrimRight(dir, string(os.PathSeparator))
	index := strings.LastIndex(trimmed, string(os.PathSeparator))
	if index < 0 {
		return dir
	}
	if index == 0 {
		return string(os.PathSeparator)
	}
	return trimmed[:index]
}
