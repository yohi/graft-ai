package ingress

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestNewHTTPServer_owns_receiver_timeouts(t *testing.T) {
	receiver, _ := newTestReceiver(t, 2)
	server := NewHTTPServer(receiver)

	if server.ReadHeaderTimeout != 5*time.Second {
		t.Fatalf("ReadHeaderTimeout = %v, want 5s", server.ReadHeaderTimeout)
	}
	if server.ReadTimeout != 30*time.Second {
		t.Fatalf("ReadTimeout = %v, want 30s", server.ReadTimeout)
	}
	if server.WriteTimeout != 10*time.Second {
		t.Fatalf("WriteTimeout = %v, want 10s", server.WriteTimeout)
	}
	if server.Handler == nil {
		t.Fatalf("server handler is nil")
	}
}

func TestHTTPServer_closes_connection_after_slow_headers(t *testing.T) {
	handlerRan := make(chan struct{}, 1)
	_, listener := startIntegrationServer(t, http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		handlerRan <- struct{}{}
	}), func(server *http.Server) { server.ReadHeaderTimeout = 50 * time.Millisecond })

	connection := dialIntegrationServer(t, listener)
	defer connection.Close()
	if _, err := io.WriteString(connection, "GET / HTTP/1.1\r\nHost: example.test\r\n"); err != nil {
		t.Fatalf("write partial headers: %v", err)
	}
	connection.SetReadDeadline(time.Now().Add(time.Second))
	var response [1]byte
	if _, err := connection.Read(response[:]); err == nil {
		t.Fatal("slow header connection remained open")
	}
	select {
	case <-handlerRan:
		t.Fatal("handler ran before request headers completed")
	default:
	}
}

func TestHTTPServer_closes_connection_after_slow_body(t *testing.T) {
	bodyReadErrors := make(chan error, 1)
	_, listener := startIntegrationServer(t, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		_, err := io.ReadAll(request.Body)
		bodyReadErrors <- err
	}), func(server *http.Server) {
		server.ReadHeaderTimeout = time.Second
		server.ReadTimeout = 50 * time.Millisecond
	})

	connection := dialIntegrationServer(t, listener)
	defer connection.Close()
	request := "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 2\r\n\r\nx"
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatalf("write partial body: %v", err)
	}
	started := time.Now()
	select {
	case err := <-bodyReadErrors:
		if err == nil {
			t.Fatal("slow body was read without a timeout")
		}
		if elapsed := time.Since(started); elapsed < 40*time.Millisecond {
			t.Fatalf("body read failed after %v, want at least the configured timeout", elapsed)
		}
	case <-time.After(time.Second):
		t.Fatal("slow body was not interrupted by ReadTimeout")
	}
}

func TestHTTPServer_times_out_blocked_response_writer(t *testing.T) {
	writeErrors := make(chan error, 1)
	_, listener := startIntegrationServer(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		chunk := bytes.Repeat([]byte("x"), 64*1024)
		for {
			if _, err := writer.Write(chunk); err != nil {
				writeErrors <- err
				return
			}
		}
	}), func(server *http.Server) { server.WriteTimeout = 50 * time.Millisecond })

	connection := dialIntegrationServer(t, listener)
	defer connection.Close()
	if _, err := io.WriteString(connection, "GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatalf("write request: %v", err)
	}
	select {
	case err := <-writeErrors:
		if err == nil {
			t.Fatal("blocked writer returned without an error")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked writer was not interrupted by WriteTimeout")
	}
}

func startIntegrationServer(t *testing.T, handler http.Handler, configure func(*http.Server)) (*http.Server, net.Listener) {
	t.Helper()
	server := NewHTTPServer(handler)
	configure(server)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	t.Cleanup(func() {
		shutdownContext, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			t.Errorf("shutdown server: %v", err)
		}
		if err := <-serveDone; err != nil && err != http.ErrServerClosed {
			t.Errorf("serve server: %v", err)
		}
	})
	return server, listener
}

func dialIntegrationServer(t *testing.T, listener net.Listener) net.Conn {
	t.Helper()
	connection, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("dial server: %v", err)
	}
	return connection
}
