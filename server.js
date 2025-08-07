import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const server = http.createServer(app);

// ★修正箇所: Socket.IOサーバーの初期化時にオプションを追加
const io = new Server(server, {
    cors: {
        origin: "*", // クロスオリジンアクセスを許可
    },
    // pingTimeout: クライアントからの応答を待つ時間を60秒に延長
    // WebRTCのシグナリングプロセスを完了させるための余裕を持たせます
    pingTimeout: 60000, 
    // pingInterval: pingを送信する間隔をデフォルトのまま25秒に設定
    pingInterval: 25000 
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

let staffSocket = null;
let unitySocket = null;
let isStaffReady = false; // Webクライアントの準備完了フラグ

io.on('connection', socket => {
    console.log(`🔗 Socket connected: ${socket.id}`);

    if (!staffSocket) {
        staffSocket = socket;
        console.log('Staff connected.');
        socket.emit('role', 'staff');
    } else if (!unitySocket) {
        unitySocket = socket;
        console.log('Unity client connected.');
        socket.emit('role', 'unity');

        if (isStaffReady) {
            console.log('Both clients connected and Staff is ready. Notifying Unity to start WebRTC.');
            unitySocket.emit('ready_to_connect');
        }
    } else {
        console.log('Connection refused: Maximum clients reached.');
        socket.disconnect();
        return;
    }

    socket.on('staff_ready', () => {
        if (socket === staffSocket) {
            isStaffReady = true;
            console.log('Staff client is ready for WebRTC. Waiting for Unity connection.');
            if (unitySocket) {
                console.log('Unity is already connected. Notifying now.');
                unitySocket.emit('ready_to_connect');
            }
        }
    });

    socket.on('offer', (offer) => {
        console.log(`Offer received from ${socket.id}`);
        if (socket === staffSocket && unitySocket) {
            console.log('Forwarding offer to Unity client.');
            unitySocket.emit('offer', offer);
        } else if (socket === unitySocket && staffSocket) {
            console.log('Forwarding offer to Staff client.');
            staffSocket.emit('offer', offer);
        }
    });

    socket.on('answer', (answer) => {
        console.log(`Answer received from ${socket.id}`);
        if (socket === staffSocket && unitySocket) {
            console.log('Forwarding answer to Unity client.');
            unitySocket.emit('answer', answer);
        } else if (socket === unitySocket && staffSocket) {
            console.log('Forwarding answer to Staff client.');
            staffSocket.emit('answer', answer);
        }
    });

    socket.on('candidate', (candidate) => {
        console.log(`Candidate received from ${socket.id}`);
        if (socket === staffSocket && unitySocket) {
            console.log('Forwarding candidate to Unity client.');
            unitySocket.emit('candidate', candidate);
        } else if (socket === unitySocket && staffSocket) {
            console.log('Forwarding candidate to Staff client.');
            staffSocket.emit('candidate', candidate);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
        if (socket === staffSocket) {
            staffSocket = null;
            isStaffReady = false;
            console.log('Staff disconnected.');
        } else if (socket === unitySocket) {
            unitySocket = null;
            console.log('Unity client disconnected.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});