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
    staff: null, // ソケットオブジェクト自体を格納
    unity: null
};

// ロールソケットを設定する関数
function setRoleSocket(role, socket) {
    if (roleSockets[role] && roleSockets[role].id !== socket.id) {
        console.log(`Disconnecting previous ${role} socket: ${roleSockets[role].id}`);
        roleSockets[role].disconnect(true);
    }
    roleSockets[role] = socket;
    console.log(`${role} registered (${socket.id})`);
}

// 接続中のソケットを取得する関数
function getSocket(role) {
    return roleSockets[role] && roleSockets[role].connected ? roleSockets[role] : null;
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

        if (getSocket("staff") && getSocket("unity")) {
            console.log('Both clients are ready. Notifying Staff to start WebRTC.');
            getSocket("staff")?.emit('start_webrtc');
        }
    });

    socket.on('offer', (offer) => {
        if (socket.id === getSocket('staff')?.id && getSocket('unity')) {
            console.log(`Forwarding offer to Unity client: ${getSocket('unity').id}`);
            console.log('💚 PWAからOfferを受信しました。Unityに転送します。');
            getSocket('unity').emit('offer', offer);
        } else {
            console.warn('Offer received from unexpected client or Unity not ready. Ignored.');
        }
    });

    socket.on('answer', (answer) => {
        if (socket.id === getSocket('unity')?.id && getSocket('staff')) {
            console.log(`Forwarding answer to Staff client: ${getSocket('staff').id}`);
            console.log('💚 UnityからAnswerを受信しました。PWAに転送します。');
            getSocket('staff').emit('answer', answer);
        } else {
            console.warn('Answer received from unexpected client or Staff not ready. Ignored.');
        }
    });

    socket.on('candidate', (candidate) => {
        if (socket.id === getSocket('staff')?.id && getSocket('unity')) {
            getSocket('unity').emit('candidate', candidate);
            console.log('💚 PWAからCandidateを受信しました。Unityに転送します。');
        } else if (socket.id === getSocket('unity')?.id && getSocket('staff')) {
            getSocket('staff').emit('candidate', candidate);
            console.log('💚 UnityからCandidateを受信しました。PWAに転送します。');
        }
    });

    socket.on('disconnect', (reason) => {
        for (const role of ["staff", "unity"]) {
            if (roleSockets[role] && roleSockets[role].id === socket.id) {
                console.log(`${role} disconnected (${reason}).`);
                
                // 相手に切断を通知
                const otherRole = role === "staff" ? "unity" : "staff";
                if (getSocket(otherRole)) {
                    console.log(`Notifying ${otherRole} about disconnect.`);
                    getSocket(otherRole).emit("webrtc_close");
                }
                roleSockets[role] = null;
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});