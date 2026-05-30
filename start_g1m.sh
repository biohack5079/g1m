#!/bin/bash

# G1M P2P Clustered Launcher (Rust + Libp2p + SQLite)
# This script starts the local signaling server, P2P syncer, and front-end interface.

echo "--- G1M P2P Launcher ---"

# 接続先のデフォルトをRenderに設定
if [ -z "$REMOTE_G1M_URL" ]; then
    export REMOTE_G1M_URL="https://dj-g1m.onrender.com"
fi

# Force local-first inference configuration
export OLLAMA_URL="http://127.0.0.1:11434"
export OLLAMA_HOST="http://127.0.0.1:11434"
export OLLAMA_MODEL="gemma3:4b-it-q4_K_M"
export LOCAL_PYTHON_AI="http://127.0.0.1:8000"

# 共有サーバーでの衝突を防ぐため、実行者固有のIDを生成
if [ ! -f .g1m_node_id ]; then
    echo "NODE-$(date +%s)-$RANDOM" > .g1m_node_id
fi
export G1M_POC_TOKEN="[PC-$(cat .g1m_node_id)]"

echo "[Local-First] Inference priority: 1. Ollama -> 2. Local Python Node -> 3. Staff PC Nodes -> 4. HF (Last Resort)"

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
    if ! ollama list | grep -q "$OLLAMA_MODEL"; then
        echo "Local Ollama found but model $OLLAMA_MODEL is missing. Pulling now..."
        ollama pull "$OLLAMA_MODEL"
    fi

    if ! curl -s "$OLLAMA_URL/api/tags" > /dev/null; then
        echo "[Ollama] Service is not running. Starting in background..."
        ollama serve > /dev/null 2>&1 &
        
        echo "Waiting for Ollama to initialize..."
        until curl -s "$OLLAMA_URL/api/tags" > /dev/null; do
            sleep 1
        done
    fi
    echo "✅ Ollama is ready!"
    echo "[Check] Ollama is configured to use: $OLLAMA_MODEL"
else
    echo "[Warning] Ollama is not installed. LLM requests will failover to Hugging Face if configured."
fi

# 2.5 Setup Python Environment for HF/Python Node
echo "[*] Setting up Python environment for HF/Local AI Node..."
if command -v python3 &> /dev/null; then
    cd hf/gaufile
    if [ ! -d ".venv" ] || [ ! -f ".venv/bin/activate" ]; then
        echo "Creating virtual environment (.venv)..."
        # 失敗したときのために残骸を消す
        rm -rf .venv
        if ! python3 -m venv .venv; then
            echo "[Info] python3-venv is missing. Attempting to install it..."
            if command -v apt-get &> /dev/null; then
                sudo apt-get update && sudo apt-get install -y python3-venv
                python3 -m venv .venv
            else
                echo "[Error] Please install python3-venv manually (e.g. apt install python3-venv) and run again."
                exit 1
            fi
        fi
    fi
    echo "Installing Python dependencies (this may take a moment)..."
    source .venv/bin/activate
    pip install -r requirements.txt > /dev/null 2>&1

    # メインのRenderサーバーへ接続してAIリソースとして登録
    echo "[Bridge] Connecting local AI Node to Remote Hub: $REMOTE_G1M_URL"
    export SIGNALING_URL="$REMOTE_G1M_URL"
    # Pythonノード側でもこのトークンを参照して登録するように設定（要Python側対応）

    # Start the Python node in the background
    echo "[Python] Starting Python AI Node (uvicorn)..."
    uvicorn app:app --host 127.0.0.1 --port 8000 > python_node.log 2>&1 &
    PYTHON_PID=$!

    # Wait for Python node to be ready
    echo "Waiting for Python AI Node to start..."
    RETRIES=0
    until curl -s http://127.0.0.1:8000/health > /dev/null 2>&1 || [ "$RETRIES" -gt 10 ]; do
        sleep 1
        ((RETRIES++))
    done
    echo "✅ Python AI Node is online!"

    deactivate
    cd ../..
else
    echo "[Warning] python3 is not installed. Skipping Python node setup."
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
        
        # ポートが衝突している場合の救済
        if grep -q "address already in use" g1m_node.log; then
            echo "Attempting to kill ghost processes..."
            fuser -k 3000/tcp 4001/tcp 2>/dev/null
        fi
        
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
trap "echo -e '\nStopping all services...'; kill $NODE_PID 2>/dev/null; kill $PYTHON_PID 2>/dev/null; exit" INT TERM
wait
