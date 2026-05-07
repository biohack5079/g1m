package main

import (
	"encoding/json"
	"io/ioutil"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
)

// ProcessRequest represents the expected payload for the /api/process endpoint
type ProcessRequest struct {
	UUID   string `json:"uuid"`
	Base64 string `json:"base64_data"`
}

// ProcessResponse represents the result of the processing
type ProcessResponse struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	UUID    string `json:"uuid,omitempty"`
}

func main() {
	// Port for the Go API (HF Spaces exposes 7860 by default)
	port := os.Getenv("PORT")
	if port == "" {
		port = "7860"
	}

	// Python LLM Server URL (running locally in the same container)
	pythonServerURL := "http://localhost:8000"
	origin, err := url.Parse(pythonServerURL)
	if err != nil {
		log.Fatalf("Invalid Python server URL: %v", err)
	}

	// Create reverse proxy to the Python LLM server
	proxy := httputil.NewSingleHostReverseProxy(origin)

	mux := http.NewServeMux()

	// 1. High-throughput distributed processing endpoint for UUID/Base64
	mux.HandleFunc("/api/process", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// リソース節約のため、大きなボディの読み込みを制限
		r.Body = http.MaxBytesReader(w, r.Body, 15*1024*1024) // 15MB limit

		body, err := ioutil.ReadAll(r.Body)
		if err != nil {
			log.Printf("[Go Backend] Error reading body: %v", err)
			http.Error(w, "Error reading body or payload too large", http.StatusBadRequest)
			return
		}
		defer r.Body.Close()

		var req ProcessRequest
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
			return
		}

		// 分散処理のシミュレーション (LLM推論を妨げないよう軽量に)
		log.Printf("[Go Backend] Received task for UUID: %s (Data Size: %d bytes)", req.UUID, len(req.Base64))

		resp := ProcessResponse{
			Status:  "success",
			Message: "Acknowledged by Go distributed backend",
			UUID:    req.UUID,
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	// 2. Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// 3. Proxy everything else to the Python FastAPI (LLM Priority)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// パフォーマンスのため、リクエストパスのログ出力のみ
		log.Printf("[Proxy] Forwarding to LLM: %s", r.URL.Path)
		proxy.ServeHTTP(w, r)
	})

	log.Printf("🚀 Go Proxy (Priority: LLM) started on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}