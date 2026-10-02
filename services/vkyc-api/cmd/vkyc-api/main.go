// Command vkyc-api serves the Wave R1 LiveKit token mint.
//
// Session create, join, claim, and end are not implemented here. Mount
// livekit.Minter.ForAccept on accept/claim and ForJoin on customer join when
// those handlers exist. POST /media/tokens is the stand-in until then.
package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/romin991/video-kyc-poc/services/vkyc-api/internal/envfile"
	"github.com/romin991/video-kyc-poc/services/vkyc-api/internal/livekit"
	"github.com/romin991/video-kyc-poc/services/vkyc-api/internal/mediahttp"
)

func main() {
	wd, err := os.Getwd()
	if err != nil {
		wd = "."
	}
	envfile.Load(wd)

	addr := strings.TrimSpace(os.Getenv("VKYC_GO_ADDR"))
	if addr == "" {
		addr = "127.0.0.1:8080"
	}

	creds := livekit.CredentialsFromEnv(os.Getenv)
	minter := livekit.NewMinter(creds)
	if creds.APIKey == "" || creds.APISecret == "" {
		log.Print("LIVEKIT_API_KEY or LIVEKIT_API_SECRET is unset. Sessions can still mint; media stays off (lk-stub tokens).")
	} else if creds.ServerURL == "" {
		log.Print("livekit tokens enabled; set LIVEKIT_URL and NEXT_PUBLIC_LIVEKIT_URL to the same WebSocket URL")
	} else {
		log.Printf("livekit tokens enabled for %s", creds.ServerURL)
	}

	mux := http.NewServeMux()
	mediahttp.Register(mux, minter, append(mediahttp.DefaultOrigins(), splitCSV(os.Getenv("CORS_ORIGINS"))...))

	log.Printf("vkyc-api-go listening on http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func splitCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	return strings.Split(raw, ",")
}
