import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// JSONボディを解析するための設定
app.use(express.json({ limit: '10mb' })); // Base64画像に対応するためlimit拡大

// --- Supabase 設定 ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const LLM_API_URL = process.env.LLM_API_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('⚠️ SUPABASE_URL or SUPABASE_KEY is not configured. Set them in .env or production environment variables.');
}
if (!LLM_API_URL) {
    console.warn('⚠️ LLM_API_URL is not configured. Set it in .env or production environment variables.');
}

const supabaseHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
};

/**
 * AI プロキシエンドポイント
 * 外部の AI API URL を隠蔽し、将来的な認証やレート制限の追加を容易にします。
 */
app.post('/api/llm', async (req, res) => {
    const { prompt } = req.body;
    if (!LLM_API_URL) {
        res.status(500).json({ error: 'LLM API endpoint is not configured.' });
        return;
    }

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (LLM_API_KEY) {
            headers.Authorization = `Bearer ${LLM_API_KEY}`;
        } else if (HUGGINGFACE_TOKEN) {
            headers.Authorization = `Bearer ${HUGGINGFACE_TOKEN}`;
        }

        const response = await fetch(LLM_API_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'gpt-20b',
                prompt: prompt
            })
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('LLM Proxy Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Kampa / Wallet API (Supabase REST) ---

/**
 * 指定された匿名IDに紐づくWallet情報を取得する。
 */
app.get('/api/kampa/wallet/:anonymousId', async (req, res) => {
    const { anonymousId } = req.params;
    try {
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/wallet_info?anonymous_id=eq.${encodeURIComponent(anonymousId)}&select=*&limit=1`,
            { headers: supabaseHeaders }
        );
        const data = await response.json();
        if (data && data.length > 0) {
            res.json(data[0]);
        } else {
            res.status(404).json({ error: 'Wallet not found' });
        }
    } catch (error) {
        console.error('Supabase GET Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Wallet情報（QRコード画像データなど）を登録・更新する。
 */
app.post('/api/kampa/wallet/register', async (req, res) => {
    const { anonymousId, walletImageData, walletType } = req.body;
    try {
        // 既存レコードを確認
        const checkRes = await fetch(
            `${SUPABASE_URL}/rest/v1/wallet_info?anonymous_id=eq.${encodeURIComponent(anonymousId)}&select=id`,
            { headers: supabaseHeaders }
        );
        const existing = await checkRes.json();

        let response;
        if (existing && existing.length > 0) {
            // 更新 (PATCH)
            response = await fetch(
                `${SUPABASE_URL}/rest/v1/wallet_info?anonymous_id=eq.${encodeURIComponent(anonymousId)}`,
                {
                    method: 'PATCH',
                    headers: supabaseHeaders,
                    body: JSON.stringify({
                        wallet_image_data: walletImageData,
                        wallet_type: walletType || 'AirWallet'
                    })
                }
            );
        } else {
            // 新規作成 (POST)
            response = await fetch(
                `${SUPABASE_URL}/rest/v1/wallet_info`,
                {
                    method: 'POST',
                    headers: supabaseHeaders,
                    body: JSON.stringify({
                        anonymous_id: anonymousId,
                        wallet_image_data: walletImageData,
                        wallet_type: walletType || 'AirWallet'
                    })
                }
            );
        }

        const result = await response.json();
        res.json(Array.isArray(result) ? result[0] : result);
    } catch (error) {
        console.error('Supabase POST Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * カンパ（模擬）のメッセージを受け取り、お礼のレスポンスを返す。
 */
app.post('/api/kampa/donate', (req, res) => {
    const { amount } = req.body;
    const message = `${amount}円送ったよ、ありがとう！応援よろしく！`;
    res.json({ message });
});

// GLBなど大きなアセットに強いキャッシュを設定（ngrok/cloudflaredの帯域節約）
// GLBは変わらないので7日間キャッシュ可
app.get('*.glb', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    next();
});
// JS/CSS バンドルも長めにキャッシュ（Viteはコンテンツハッシュ付きファイル名を使う）
app.get(/\.(js|css|wasm)$/, (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    next();
});

// 静的ファイルの提供（Reactのビルド済みファイル）
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// どのルートに対しても index.html を返す (SPA対応)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
});

// SocketIDと接続状態を管理
const participants = new Map(); // socket.id -> { socket, role, anonymousId }

/**
 * 送信者以外の全参加者にメッセージをブロードキャストする
 */
function broadcast(socket, event, data) {
    socket.broadcast.emit(event, data);
}

io.on('connection', socket => {
    console.log(`🔗 New socket connected: ${socket.id}`);

    socket.on('register_role', (payload) => {
        // payloadはオブジェクト { role, anonymousId } または文字列 "staff"/"unity"/"viewer" を許容
        let role, anonymousId;
        if (typeof payload === 'string') {
            role = payload;
            anonymousId = null;
        } else {
            role = payload.role;
            anonymousId = payload.anonymousId || null;
        }

        if (role !== "staff" && role !== "unity" && role !== "viewer") {
            console.warn(`⚠️ Rejecting connection from unknown role: ${role}. Disconnecting...`);
            socket.disconnect();
            return;
        }

        // 既に登録済みの場合は重複登録を防ぐ（再接続・再読み込み対策）
        if (participants.has(socket.id)) {
            console.warn(`⚠️ Socket ${socket.id} already registered as ${participants.get(socket.id).role}. Ignoring duplicate register_role.`);
            return;
        }

        participants.set(socket.id, { socket, role, anonymousId });
        console.log(`✅ ${role} registered with socket ID: ${socket.id} (anonId: ${anonymousId}) | Total: ${participants.size}`);

        // 現在の全参加者リストを新しく入った人に送る
        const others = Array.from(participants.entries())
            .filter(([id]) => id !== socket.id)
            .map(([id, info]) => ({ id, role: info.role, anonymousId: info.anonymousId }));

        socket.emit('participants_list', others);

        // 他の人に新しい人が入ったことを通知
        broadcast(socket, 'participant_joined', { id: socket.id, role, anonymousId });
    });

    socket.on('offer', (data) => {
        const { targetId, sdp } = data;
        const target = participants.get(targetId);
        if (target) {
            console.log(`➡️ Offer from ${socket.id} to ${targetId}`);
            target.socket.emit('offer', { from: socket.id, sdp });
        } else {
            console.warn(`⚠️ Target ${targetId} not found for offer from ${socket.id}`);
        }
    });

    socket.on('answer', (data) => {
        const { targetId, sdp } = data;
        const target = participants.get(targetId);
        if (target) {
            console.log(`⬅️ Answer from ${socket.id} to ${targetId}`);
            target.socket.emit('answer', { from: socket.id, sdp });
        } else {
            console.warn(`⚠️ Target ${targetId} not found for answer from ${socket.id}`);
        }
    });

    socket.on('candidate', (data) => {
        const { targetId, candidate } = data;
        const target = participants.get(targetId);
        if (target) {
            console.log(`➡️ Candidate from ${socket.id} to ${targetId}`);
            target.socket.emit('candidate', { from: socket.id, candidate });
        } else {
            console.warn(`⚠️ Target ${targetId} not found for candidate from ${socket.id}`);
        }
    });

    // WebRTC接続完了を通知するイベント
    socket.on('webrtc_connected', () => {
        console.log(`🎉 WebRTC connection confirmed by ${socket.id}.`);
    });

    socket.on('disconnect', (reason) => {
        console.log(`🔌 Socket disconnected: ${socket.id} (reason: ${reason}) | Remaining: ${participants.size - 1}`);
        if (participants.has(socket.id)) {
            participants.delete(socket.id);
            // 他の人に退出を通知
            broadcast(socket, 'participant_left', { id: socket.id });
            console.log(`🗑️ Cleaned up ${socket.id} | Total now: ${participants.size}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});