package ingress

import (
	"net/http"
	"time"
)

func NewHTTPServer(receiver http.Handler) *http.Server {
	return &http.Server{
		Handler:           receiver,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      10 * time.Second,
	}
}
