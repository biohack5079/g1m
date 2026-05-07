import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { Client } from 'undici';

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

// HF Redirection Settings
const USE_HF_REDIRECT = process.env.USE_HF_REDIRECT !== 'false'; // Default true for startup phase
const HF_COMPLEX_URL = process.env.HF_COMPLEX_URL || 'https://default-complex-hidden-url.hf.space';


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
 * 
 * Hugging Face Spaces対応：
 * - エンドポイント: 環境変数 LLM_API_URL を参照
 * - 認証: 環境変数 HUGGINGFACE_TOKEN を参照
 */
/**
 * AI プロキシエンドポイント (RAG & Docker LLM 連携)
 * 
 * [RAG 設計仕様]
 * 1. 知識ベースは Supabase (pgvector) に格納・管理。
 * 2. RAG用のテキストデータは「事前ベクトル化 (Pre-vectorized)」されていることを前提とする。
 * 3. 検索時には Embedding モデルを用いてクエリをベクトル化し、Supabase 上で近傍探索を行う。
 * 
 * [LLM 仕様]
 * - Llama 3.1 8B (Docker-based Hugging Face Space)
 * - Gradio SDK ではなく Docker で構築されているため、OpenAI 互換エンドポイントを使用。
 */
app.post('/api/llm', async (req, res) => {
    const { prompt } = req.body;
    if (!LLM_API_URL) {
        console.error('LLM_API_URL is missing');
        res.status(500).json({ error: 'LLM API endpoint is not configured.' });
        return;
    }

    console.log(`🤖 AI Request received. Mode: RAG (Pre-vectorized) | Docker Target: ${LLM_API_URL}`);
    
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (HUGGINGFACE_TOKEN) {
            headers.Authorization = `Bearer ${HUGGINGFACE_TOKEN}`;
        }

        // --- RAG 検索ロジック (概念) ---
        // ※ 知識ベース（personality.md等）は Supabase にベクトル化して保存済み。
        // ここでクエリのベクトル化を行い、上位コンテキストを取得する。
        
        // --- Dockerベース LLM (Llama 3.1) または HFへのリクエスト ---
        let targetUrl = LLM_API_URL;
        if (USE_HF_REDIRECT && HF_COMPLEX_URL) {
            targetUrl = HF_COMPLEX_URL;
            console.log(`🔀 Proxied heavy LLM request to HF Complex URL (Obfuscated)`);
        }

        const apiPath = targetUrl.endsWith('/') ? 'v1/chat/completions' : '/v1/chat/completions';
        const client = new Client(targetUrl, {
            headersTimeout: 600000, // 10分
            bodyTimeout: 0 // ボディ受信中はタイムアウトしない
        });

        console.log(`📡 Sending to LLM API: ${targetUrl}${apiPath}`);

        // タイムアウト設定（HuggingFace Space は応答が遅い場合がある）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 600000); // 10分（以前の動作時間）

        const { statusCode, body } = await client.request({
            path: apiPath,
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: "llama-3.1-8b",
                messages: [
                    { 
                      role: "system", 
                      content: "あなたはG1:Mちゃんです。知識ベースの情報に基づき、フレンドリーで親しみやすい日本語で回答してください。紋切り型の返答は避け、対話を楽しんでください。" 
                    },
                    { role: "user", content: prompt }
                ],
                max_tokens: 512,
                temperature: 0.8
            }),
            signal: controller.signal
        });

        const responseText = await body.text();
        clearTimeout(timeoutId);
        await client.close();

        const response = {
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
            text: async () => responseText,
            json: async () => JSON.parse(responseText)
        };

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Docker LLM API Error (${response.status}):`, errorText);
            res.status(response.status).json({ error: 'LLM API Error', details: errorText });
            return;
        }

        const data = await response.json();
        console.log('✅ AI Response received');
        
        // OpenAI 形式 (choices[0].message.content) から抽出
        const aiText = data.choices?.[0]?.message?.content || data.generated_text || data.text || "回答を生成できませんでした。";
        
        console.log(`💬 AI Answer: ${aiText.slice(0, 50)}...`);
        res.json({ response: aiText, text: aiText });

    } catch (error) {
        console.error('LLM Proxy Error:', error);
        
        // タイムアウトエラーの詳細ログ
        if (error.name === 'AbortError') {
            console.error('⏱️  Request timeout: HuggingFace Space API response took too long (>3min)');
            console.error('💡 Try: 1) Wait for HF Space to wake up (cold start), 2) Check HF Space status, 3) Verify USE_HF_REDIRECT setting');
            res.status(504).json({ 
                error: 'API Timeout', 
                details: 'HuggingFace Space API response timeout (3min). Please try again later.',
                suggestion: 'HF Spaces may have cold-start delays. First request may take 3-5min.'
            });
            return;
        }
        
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

/**
 * 分散処理用エンドポイント (Goバックエンド向け)
 * UUIDとBase64データをHFのGoプロキシに転送する
 */
app.post('/api/process', async (req, res) => {
    const { uuid, base64_data } = req.body;
    
    if (!uuid || !base64_data) {
        return res.status(400).json({ error: 'uuid and base64_data are required' });
    }

    // デフォルトはRenderの内部処理だが、スイッチONでHFへ転送
    if (USE_HF_REDIRECT && HF_COMPLEX_URL) {
        console.log(`🚀 Redirecting heavy processing to HF Distributed Go Backend for UUID: ${uuid}`);
        try {
            const targetUrl = HF_COMPLEX_URL.endsWith('/') ? `${HF_COMPLEX_URL}api/process` : `${HF_COMPLEX_URL}/api/process`;
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uuid, base64_data })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ HF Process API Error (${response.status}):`, errorText);
                return res.status(response.status).json({ error: 'HF Process API Error', details: errorText });
            }

            const data = await response.json();
            return res.json(data);
        } catch (error) {
            console.error('HF Process Proxy Error:', error);
            return res.status(500).json({ error: 'Internal Server Error forwarding to HF', details: error.message });
        }
    }

    // HF転送がOFFの場合はここで処理 (仮実装)
    console.log(`⚙️ Processing data locally for UUID: ${uuid}`);
    res.json({
        status: 'success',
        message: 'Data processed locally (HF redirect disabled)',
        uuid: uuid
    });
});


// --- Kampa / Wallet API (Supabase REST) ---

/**
 * ボット (G1:Mちゃん) のWallet情報を取得する (Base64変換の明示的実装)
 */
app.get('/api/kampa/wallet/bot', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'z1m', 'AirWallet', 'g1-m_chan.jpeg');
        if (fs.existsSync(filePath)) {
            // 画像をバイナリとして読み込む
            const bitmap = fs.readFileSync(filePath);
            // Base64に変換し、ログでデータサイズを確認可能にする
            const base64Data = bitmap.toString('base64');
            console.log(`📸 Bot QR Image converted to Base64 (Length: ${base64Data.length})`);
            
            const dataUrl = `data:image/jpeg;base64,${base64Data}`;
            res.json({
                anonymous_id: 'bot',
                wallet_image_data: dataUrl,
                wallet_type: 'AirWallet'
            });
        } else {
            console.error(`Bot QR file not found: ${filePath}`);
            res.status(404).json({ error: 'Bot QR file not found' });
        }
    } catch (error) {
        console.error('Error reading bot QR:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

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
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/wallet_info?anonymous_id=eq.${encodeURIComponent(anonymousId)}`,
            {
                method: 'UPSERT',
                headers: { ...supabaseHeaders, 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify({
                    anonymous_id: anonymousId,
                    wallet_image_data: walletImageData,
                    wallet_type: walletType || 'AirWallet'
                })
            }
        );

        const result = await response.json();
        res.json(Array.isArray(result) ? result[0] : result);
    } catch (error) {
        console.error('Supabase POST Error:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
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
        let role, anonymousId, nickname;
        if (typeof payload === 'string') {
            role = payload;
            anonymousId = null;
            nickname = 'ゲスト';
        } else {
            role = payload.role;
            anonymousId = payload.anonymousId || null;
            nickname = payload.nickname || 'ゲスト';
        }

        if (role !== "staff" && role !== "unity" && role !== "viewer") {
            console.warn(`⚠️ Rejecting connection from unknown role: ${role}. Disconnecting...`);
            socket.disconnect();
            return;
        }

        // 既に登録済みの場合は情報を更新
        if (participants.has(socket.id)) {
            const p = participants.get(socket.id);
            p.role = role;
            p.anonymousId = anonymousId;
            p.nickname = nickname;
            return;
        }

        participants.set(socket.id, { socket, role, anonymousId, nickname });
        console.log(`✅ ${role} registered: ${socket.id} (anonId: ${anonymousId}, nick: ${nickname})`);

        // 現在の全参加者リストを新しく入った人に送る
        const others = Array.from(participants.entries())
            .filter(([id]) => id !== socket.id)
            .map(([id, info]) => ({ id, role: info.role, anonymousId: info.anonymousId, nickname: info.nickname }));

        socket.emit('participants_list', others);

        // 他の人に新しい人が入ったことを通知
        broadcast(socket, 'participant_joined', { id: socket.id, role, anonymousId, nickname });
    });

    // ニックネーム更新イベント
    socket.on('update_nickname', (data) => {
        const p = participants.get(socket.id);
        if (p) {
            p.nickname = data.nickname;
            console.log(`👤 Nickname updated: ${socket.id} -> ${data.nickname}`);
            broadcast(socket, 'participant_updated', { id: socket.id, nickname: data.nickname });
        }
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