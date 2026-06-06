#!/bin/bash

# G1M P2P Clustered Launcher (Rust + Libp2p + SQLite)
# This script starts the local signaling server, P2P syncer, and front-end interface.

echo "--- G1M P2P Launcher (Rust Core) ---"

# 接続先 (Hub) の優先順位: 1. スクリプト引数 $1, 2. 環境変数, 3. Render (デフォルト)
if [ ! -z "$1" ]; then
    export REMOTE_G1M_URL="$1"
    echo "[Config] 接続先を引数から設定しました: $REMOTE_G1M_URL"
elif [ -z "$REMOTE_G1M_URL" ]; then
    export REMOTE_G1M_URL="https://dj-g1m.onrender.com"
    echo "[Config] デフォルトの接続先 (Render) を使用します: $REMOTE_G1M_URL"
fi

if [[ "$REMOTE_G1M_URL" == *"trycloudflare.com"* ]]; then
    echo "⚠️ [Tunnel Note] モデル読込が止まる場合は、必ず --protocol http2 を付けて cloudflared を起動してください。"
fi

# Force local-first inference configuration
export OLLAMA_URL="http://127.0.0.1:11434"
export OLLAMA_HOST="http://127.0.0.1:11434"
export OLLAMA_MODEL="gemma3:4b-it-q4_K_M"
export LOCAL_PYTHON_AI="http://127.0.0.1:8000"
export BOT_CNC_ID="g1m" # 管理人のUUIDに置き換え可能

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

# 0.5 Start Java Backend (Docker) for Wallet & DB features
DOCKER_COMPOSE_CMD=""
if command -v docker-compose &> /dev/null; then DOCKER_COMPOSE_CMD="docker-compose";
elif docker compose version &> /dev/null; then DOCKER_COMPOSE_CMD="docker compose"; fi

if [[ "$*" == *"--no-java"* ]]; then
    echo "[0.5/3] Skipping Java backend (Wallet/DB) to save memory."
else
    if [ ! -z "$DOCKER_COMPOSE_CMD" ]; then
        echo "[0.5/3] Starting Java backend (Docker)..."
        # JVMのメモリ使用量を抑制 (最大256MB)
        cd z1m/java-unit && JAVA_OPTS="-Xmx256m" $DOCKER_COMPOSE_CMD up -d --build && cd ../..
        sleep 3
        docker ps | grep z1m-java-unit || echo "⚠️ Java backend failed to start."
        echo "✅ Java backend is starting in background (Port 8080)"
    else
        echo "[Warning] Docker Compose not found. Java backend will not be available."
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
# メモリ確保のためキャッシュをクリア (Linux) - パスワード入力を避けるため無効化
# sync && sudo sysctl -w vm.drop_caches=3 2>/dev/null || true

# ポートを占有しているプロセスを特定して確実に殺す
fuser -k 3000/tcp 4001/tcp 2>/dev/null || true
pkill -9 -f "g1m-node" 2>/dev/null || true
pkill -9 -f "node.*bridge" 2>/dev/null || true
pkill -9 -f "uvicorn.*app:app" 2>/dev/null || true
sleep 2 # OSがソケットを完全に解放するまで待機

# Nodeの実行優先度を正常に戻し、レスポンスを改善
./g1m-node/target/release/g1m-node 2>&1 | tee -a g1m_node.log &
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

if [ ! -d "frontend/dist" ]; then
    echo "[Info] Building frontend with memory limits..."
    cd frontend && NODE_OPTIONS="--max-old-space-size=512" npm run build && cd ..
    sync
else
    echo "[Info] frontend/dist already exists. Skipping build to save memory."
fi

echo "--- G1M is fully operational! ---"
echo "Web interface: http://localhost:3000"
echo "P2P Port: 4001"

# [Bridge] このPCをRenderサーバー側の「Staff」として登録するためのバックグラウンド処理
# これにより、Render上のサイトを見ている人からも、あなたのPCが「Active」に見えるようになります。
echo "[Bridge] Connecting to Remote Signaling: $REMOTE_G1M_URL"
export NODE_PATH="$(pwd)/frontend/node_modules"
# cloudflared を 3000 番 (Rust) に向け、Node.js ブリッジも 3000 番を監視する
node <<'EOF' 2>&1 | tee -a bridge.log &
const io = require('socket.io-client');
// Render等のプロキシ環境では、ポーリングをスキップして最初からWebSocketを使用することで
// 接続の切断やタイムアウトを劇的に減らすことができます。
const connectionOptions = {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    pingInterval: 20000, 
    pingTimeout: 60000,
    upgradeTimeout: 30000
};
const socket = io(process.env.REMOTE_G1M_URL, connectionOptions);
const localSocket = io('http://127.0.0.1:3000', connectionOptions);

const register = async (s, name) => {
    s.on('connect', async () => {
        // Ollama の生存確認を行う
        try {
            const health = await fetch('http://127.0.0.1:11434/api/tags');
            if (!health.ok) throw new Error('Ollama not ready');
            console.log(`✅ [BRIDGE] AI Engine (Ollama) is alive.`);
        } catch (e) {
            console.warn(`⚠️ [BRIDGE] AI Engine not found. Registering as viewer only.`);
            // AIがいない場合は viewer として登録し、Active Node カウントを増やさない
            s.emit('register_role', { role: 'viewer', nickname: 'Local-PC (No-AI)' });
            return;
        }

        // AIが生きている場合のみ staff として登録
        s.emit('register_role', { role: 'staff', pocToken: process.env.G1M_POC_TOKEN, nickname: 'Local-PC' });
        console.log(`✅ [BRIDGE] ${name} に接続成功 (${new Date().toLocaleTimeString()})`);
    });
    s.on('disconnect', (reason) => {
        console.warn(`⚠️ [BRIDGE] ${name} から切断されました: ${reason}`);
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
    console.log(`📥 [BRIDGE] Task Received: ${data.taskId} - Prompt: "${data.prompt.substring(0,30)}..."`);
    s.emit('system_log', { message: `⚡ PC Node (${process.env.G1M_POC_TOKEN}) で推論を開始...` });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3600000); // 1時間タイムアウト

    try {
        const res = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                model: process.env.OLLAMA_MODEL || 'gemma3:4b-it-q4_K_M',
                messages: [
                    { role: 'system', content: 'あなたはG1:Mちゃんです。フレンドリーな日本語で回答してください。' },
                    { role: 'user', content: data.prompt }
                ],
                stream: false
            }),
            signal: controller.signal
        });
        const json = await res.json();
        // OpenAI互換形式 (choices[0].message.content) と Ollama標準形式 (message.content) の両方に対応
        const text = (json.choices && json.choices[0] && json.choices[0].message) ? json.choices[0].message.content : (json.message ? json.message.content : (json.response || json.error || "⚠️ Ollamaからの応答が空です"));
        console.log(`✅ [BRIDGE] 推論成功。結果を返送します。`);
        s.emit('task_result', { taskId: data.taskId, result: text });
    } catch (e) {
        console.error(`❌ [BRIDGE] 逆流処理エラー: ${e.message}`);
        s.emit('task_result', { taskId: data.taskId, result: "⚠️ ローカルAIノードとの通信に失敗しました。Ollamaが起動しているか確認してください。" });
    } finally {
        clearTimeout(timeoutId);
    }
};

socket.on('distribute_task', (data) => { console.log("📡 [Remote] distribute_task received"); handleTask(socket, data); });
localSocket.on('distribute_task', (data) => { console.log("📡 [Local] distribute_task received"); handleTask(localSocket, data); });
EOF
BRIDGE_PID=$!

echo "Press Ctrl+C to shut down all local processes."

# Maintain running processes
trap "echo -e '\nStopping all services...'; kill -9 $NODE_PID $BRIDGE_PID 2>/dev/null; fuser -k 3000/tcp 4001/tcp 2>/dev/null; cd z1m/java-unit && docker-compose down && cd ../..; exit" INT TERM
wait
