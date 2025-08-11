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

// 静的ファイルの提供（publicディレクトリ）
app.use(express.static(path.join(__dirname, 'public')));

// SocketIDで管理
const roleSockets = {
    staff: null, // 例: { socket, id }
    unity: null
};

function setRoleSocket(role, socket) {
    if (roleSockets[role] && roleSockets[role].id && roleSockets[role].id !== socket.id) {
        roleSockets[role].socket.disconnect();
        console.log(`Disconnected previous ${role} socket: ${roleSockets[role].id}`);
    }
    roleSockets[role] = { socket, id: socket.id };
    console.log(`${role} registered (${socket.id})`);
}

function getSocket(role) {
    if (!roleSockets[role]) return null;
    return roleSockets[role].socket.connected ? roleSockets[role].socket : null;
}

io.on('connection', socket => {
    console.log(`🔗 Socket connected: ${socket.id}`);

    socket.on('register_role', (role) => {
        if (role !== "staff" && role !== "unity") {
            console.log(`Reject unknown role: ${role}`);
            socket.disconnect();
            return;
        }
        setRoleSocket(role, socket);

        // 両者準備OK
        if (getSocket("staff") && getSocket("unity")) {
            console.log('Both clients are ready. Notifying Staff to start WebRTC.');
            getSocket("staff")?.emit('start_webrtc');
        }
    });

    socket.on('offer', (offer) => {
        if (socket === getSocket('staff') && getSocket('unity')) {
            console.log(`Forwarding offer to Unity client: ${getSocket('unity').id}`);
            console.log('💚 PWAからOfferを受信しました。Unityに転送します。');
            getSocket('unity').emit('offer', offer);
        } else {
            console.warn('Offer received from unexpected client or Unity not ready. Ignored.');
        }
    });

    socket.on('answer', (answer) => {
        if (socket === getSocket('unity') && getSocket('staff')) {
            console.log(`Forwarding answer to Staff client: ${getSocket('staff').id}`);
            console.log('💚 UnityからAnswerを受信しました。PWAに転送します。');
            getSocket('staff').emit('answer', answer);
        } else {
            console.warn('Answer received from unexpected client or Staff not ready. Ignored.');
        }
    });

    socket.on('candidate', (candidate) => {
        if (socket === getSocket('staff') && getSocket('unity')) {
            console.log('💚 PWAからCandidateを受信しました。Unityに転送します。');
            getSocket('unity').emit('candidate', candidate);
        } else if (socket === getSocket('unity') && getSocket('staff')) {
            console.log('💚 UnityからCandidateを受信しました。PWAに転送します。');
            getSocket('staff').emit('candidate', candidate);
        }
    });

    socket.on('disconnect', () => {
        for (const role of ["staff", "unity"]) {
            if (roleSockets[role]?.id === socket.id) {
                roleSockets[role] = null;
                console.log(`${role} disconnected.`);
            }
        }
        // 相手への通知
        if (getSocket("staff")) getSocket("staff").emit("webrtc_close");
        if (getSocket("unity")) getSocket("unity").emit("webrtc_close");
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});