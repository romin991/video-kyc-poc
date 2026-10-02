package livekit

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/livekit/protocol/auth"
)

const (
	RoleAgent    = "agent"
	RoleCustomer = "customer"

	tokenTTL         = 10 * time.Minute
	refreshBefore    = 60 * time.Second
	maxSessionIDSize = 128
)
