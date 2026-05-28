#!/bin/bash

# G1M P2P Clustered Launcher (Rust + Libp2p + SQLite)
# This script starts the local signaling server, P2P syncer, and front-end interface.

echo "--- G1M P2P Launcher ---"

# 0. Check for Rust/Cargo compiler
if ! command -v cargo &> /dev/null; then
    echo "[Info] Rust/Cargo not found. Attempting auto-installation..."
    if command -v apt-get &> /dev/null; then
        echo "Updating package list and installing Rust..."
        sudo apt-get update && sudo apt-get install -y cargo rustc
    else
        echo "[Error] Cargo is not installed. Please install Rust via:"
        echo "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
        exit 1
    fi
fi

# 1. Compile the Rust P2P signaling node
echo "[1/3] Building Rust P2P node..."
cd g1m-node
cargo build --release
if [ $? -ne 0 ]; then
    echo "[Error] Rust build failed."
    exit 1
fi
cd ..

# 2. Check for local Ollama service (LLM)
if command -v ollama &> /dev/null; then
    MODEL="gemma3:4b-it-q4_K_M"
    if ! ollama list | grep -q "$MODEL"; then
        echo "Local Ollama found but model $MODEL is missing. Pulling now..."
        ollama pull "$MODEL" &
    fi

    if ! curl -s http://localhost:11434/api/tags > /dev/null; then
        echo "Ollama service is not running. Starting in background..."
        ollama serve > /dev/null 2>&1 &
        sleep 5
    fi
else
    echo "[Warning] Ollama is not installed. LLM requests will failover to Hugging Face if configured."
fi

# 3. Start the compiled Rust P2P Node
echo "[2/3] Launching Rust P2P node..."
# Kill any existing process on port 3000
if command -v fuser >/dev/null; then
    fuser -k 3000/tcp >/dev/null 2>&1 || true
    fuser -k 4001/tcp >/dev/null 2>&1 || true
fi

# Run the node
./g1m-node/target/release/g1m-node > g1m_node.log 2>&1 &
NODE_PID=$!

echo "Waiting for Rust node to start on port 3000..."
RETRIES=0
while ! curl -s http://localhost:3000/healthz > /dev/null; do
    sleep 1
    echo -n "."
    RETRIES=$((RETRIES+1))
    if [ $RETRIES -gt 15 ]; then
        echo -e "\n[Error] Rust node failed to start. See g1m_node.log"
        tail -n 20 g1m_node.log
        kill $NODE_PID 2>/dev/null
        exit 1
    fi
done
echo -e "\n✅ Rust P2P Node is online!"

# 4. Open Frontend
echo "[3/3] Preparing frontend interface..."
# Build frontend assets if not built yet
if [ ! -d "frontend/dist" ]; then
    echo "Frontend build missing. Building assets..."
    cd frontend && npm install && npm run build && cd ..
fi

echo "--- G1M is fully operational! ---"
echo "Web interface: http://localhost:3000"
echo "P2P Port: 4001"
echo "Press Ctrl+C to shut down all local processes."

# Maintain running processes
trap "echo -e '\nStopping all services...'; kill $NODE_PID; exit" INT TERM
wait
