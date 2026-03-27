import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

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
app.use(express.json());

/**
 * AI プロキシエンドポイント
 * 外部の AI API URL を隠蔽し、将来的な認証やレート制限の追加を容易にします。
 */
app.post('/api/llm', async (req, res) => {
    const { prompt } = req.body;
    try {
        const response = await fetch('https://cybernetcall-plower.hf.space/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

// 静的ファイルの提供（publicディレクトリ）
app.use(express.static(path.join(__dirname, 'public')));

// SocketIDと接続状態を管理
const participants = new Map(); // socket.id -> { socket, role }

/**
 * 送信者以外の全参加者にメッセージをブロードキャストする
 */
function broadcast(socket, event, data) {
    socket.broadcast.emit(event, data);
}

io.on('connection', socket => {
    console.log(`🔗 New socket connected: ${socket.id}`);

    socket.on('register_role', (role) => {
        if (role !== "staff" && role !== "unity" && role !== "viewer") {
            console.warn(`⚠️ Rejecting connection from unknown role: ${role}. Disconnecting...`);
            socket.disconnect();
            return;
        }

        participants.set(socket.id, { socket, role });
        console.log(`✅ ${role} registered with socket ID: ${socket.id}`);

        // 現在の全参加者リストを新しく入った人に送る
        const others = Array.from(participants.entries())
            .filter(([id]) => id !== socket.id)
            .map(([id, info]) => ({ id, role: info.role }));

        socket.emit('participants_list', others);

        // 他の人に新しい人が入ったことを通知
        broadcast(socket, 'participant_joined', { id: socket.id, role });
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

    socket.on('disconnect', () => {
        console.log(`🔌 Socket disconnected: ${socket.id}`);
        if (participants.has(socket.id)) {
            participants.delete(socket.id);
            // 他の人に退出を通知
            broadcast(socket, 'participant_left', { id: socket.id });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});