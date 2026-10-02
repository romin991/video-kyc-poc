package main

import (
	"log"
	"net/http"
	"time"

	"github.com/romin991/video-kyc-poc/apps/go-api/internal/config"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/httpapi"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/livekit"
	"github.com/romin991/video-kyc-poc/apps/go-api/internal/session"
)

func main() {
	cfg := config.Load()
	handler := httpapi.New(session.NewStore(), cfg, livekit.New(cfg.LiveKitAPIKey, cfg.LiveKitAPISecret))
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("vkyc api  http://%s", cfg.Addr)
	log.Printf("join urls use %s", cfg.CustomerOrigin)
	if cfg.LiveKitAPIKey != "" && cfg.LiveKitAPISecret != "" {
		if cfg.LiveKitURL != "" {
			log.Printf("livekit %s", cfg.LiveKitURL)
		} else {
			log.Print("livekit tokens enabled; set LIVEKIT_URL and NEXT_PUBLIC_LIVEKIT_URL to the same WebSocket URL")
		}
	} else {
		log.Print("LIVEKIT_API_KEY or LIVEKIT_API_SECRET is unset. Sessions still accept and join; media stays off.")
	}

	log.Fatal(server.ListenAndServe())
}
