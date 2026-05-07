#!/bin/sh

# Start the Python Llama FastAPI server in the background on port 8000
echo "Starting Python Llama Server on port 8000..."
uvicorn app:app --host 0.0.0.0 --port 8000 &

# Wait a moment for Python to start
sleep 3

# Start the Go Proxy and Distributed Processor on port 7860
echo "Starting Go Proxy on port 7860..."
./proxy
