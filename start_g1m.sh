#!/bin/bash

# G1M P2P Clustered Launcher (Rust + Libp2p + SQLite)
# This script starts the local signaling server, P2P syncer, and front-end interface.

echo "--- G1M P2P Launcher ---"

# 接続先 (Hub) の優先順位: 1. スクリプト引数 $1, 2. 環境変数, 3. Render (デフォルト)
if [ ! -z "$1" ]; then
    export REMOTE_G1M_URL="$1"
    echo "[Config] 接続先を引数から設定しました: $REMOTE_G1M_URL"
elif [ -z "$REMOTE_G1M_URL" ]; then
    export REMOTE_G1M_URL="https://dj-g1m.onrender.com"
    echo "[Config] デフォルトの接続先 (Render) を使用します: $REMOTE_G1M_URL"
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
# メモリ節約のため、Python AI Nodeは無効化しました（Ollamaを使用します）。
PYTHON_PID=""


# 3. Start the compiled Rust P2P Node
echo "[2/3] Launching Rust P2P node..."
echo "Forcefully cleaning up ports 3000 and 4001 to prevent 'Address already in use'..."
# ポートを占有しているプロセスを特定して確実に殺す
fuser -k 3000/tcp 4001/tcp 2>/dev/null || true
pkill -9 -f "g1m-node" 2>/dev/null || true
pkill -9 -f "node.*bridge" 2>/dev/null || true
pkill -9 -f "uvicorn.*app:app" 2>/dev/null || true
sleep 2 # OSがソケットを完全に解放するまで待機

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

# 3.5 Check for Node.js dependencies
if [ ! -d "node_modules" ]; then
    echo "[*] Node.js dependencies not found in root. Installing..."
    if command -v npm &> /dev/null; then
        npm install
    else
        echo "[Error] npm is not installed. Please install Node.js to use the 'dev' command."
        # start_g1m.sh 自体は Rust/Python で動くため続行可能ですが、警告を出します
    fi
fi

# 4. Open Frontend
echo "[3/3] Preparing frontend interface..."

# 接続先がRenderに固定されないよう、ローカル実行時は常に再ビルドするか、
# 少なくとも古いビルドを削除してローカルホストを向くようにします。
if [ -d "frontend/dist" ]; then
    echo "Refreshing frontend build for local environment..."
    rm -rf frontend/dist
fi
cd frontend && npm run build && cd ..

echo "--- G1M is fully operational! ---"
echo "Web interface: http://localhost:3000"
echo "P2P Port: 4001"

# [Bridge] このPCをRenderサーバー側の「Staff」として登録するためのバックグラウンド処理
# これにより、Render上のサイトを見ている人からも、あなたのPCが「Active」に見えるようになります。
echo "[Bridge] Connecting to Remote Signaling: $REMOTE_G1M_URL"
export NODE_PATH="$(pwd)/frontend/node_modules"
node <<'EOF' 2>&1 | tee -a bridge.log &
const io = require('socket.io-client');
const socket = io(process.env.REMOTE_G1M_URL);
const localSocket = io('http://localhost:3000');

const register = (s, name) => {
    s.on('connect', () => {
        s.emit('register_role', { role: 'staff', pocToken: process.env.G1M_POC_TOKEN, nickname: 'Local-PC' });
        console.log(`✅ [BRIDGE] ${name} に接続完了。推論タスクの待機を開始します。`);
    });
    s.on('connect_error', (err) => {
        console.error(`❌ [BRIDGE] ${name} 接続エラー: ${err.message}`);
    });
};

register(socket, 'Remote Hub');
register(localSocket, 'Local Node');

// タスクが飛んできたらローカルのAIに投げて、結果を返すロジック
// ポート8000(Python)ではなく11434(Ollama)のOpenAI互換エンドポイントを使用
const handleTask = async (s, data) => {
    console.log(`\n📥 [BRIDGE] 逆流タスク受信: "${data.prompt.substring(0,50)}..."`);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3600000); // 1時間タイムアウト

        const res = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                model: 'gemma3:4b-it-q4_K_M',
                messages: [
                    { role: 'system', content: 'あなたはG1:Mちゃんです。親しみやすい日本語で回答してください。' },
                    { role: 'user', content: data.prompt }
                ]
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        const text = json.choices ? json.choices[0].message.content : (json.response || json.text || "応答なし");
        console.log(`✅ [BRIDGE] 推論成功。結果を返送します。`);
        s.emit('task_result', { taskId: data.taskId, result: text });
    } catch (e) {
        console.error(`❌ [BRIDGE] 逆流処理エラー: ${e.message}`);
    }
};

socket.on('distribute_task', (data) => handleTask(socket, data));
localSocket.on('distribute_task', (data) => handleTask(localSocket, data));
EOF
BRIDGE_PID=$!

echo "Press Ctrl+C to shut down all local processes."

# Maintain running processes
trap "echo -e '\nStopping all services...'; kill -9 $NODE_PID $BRIDGE_PID 2>/dev/null; fuser -k 3000/tcp 4001/tcp 2>/dev/null; exit" INT TERM
wait
