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

// SocketIDと接続状態を管理
const roleSockets = {
    staff: null, 
    unity: null
};

/**
 * 新しいソケットを役割に割り当て、既存のソケットを強制的に切断する。
 * @param {string} role - 役割 ("staff" or "unity")
 * @param {Socket} newSocket - 新しく接続したソケット
 */
function setRoleSocket(role, newSocket) {
    if (roleSockets[role] && roleSockets[role].id !== newSocket.id) {
        console.log(`🔌 Previous ${role} socket (${roleSockets[role].id}) detected. Disconnecting...`);
        try {
            roleSockets[role].socket.disconnect();
        } catch (e) {
            console.error(`Failed to disconnect previous socket: ${e}`);
        }
    }
    roleSockets[role] = { socket: newSocket, id: newSocket.id };
    console.log(`✅ ${role} registered with socket ID: ${newSocket.id}`);
}

/**
 * 指定された役割の有効なソケットを取得する。
 * @param {string} role - 役割 ("staff" or "unity")
 * @returns {Socket|null} - 接続中のソケット、またはnull
 */
function getSocket(role) {
    if (!roleSockets[role]) return null;
    return roleSockets[role].socket.connected ? roleSockets[role].socket : null;
}

io.on('connection', socket => {
    console.log(`🔗 New socket connected: ${socket.id}`);

    socket.on('register_role', (role) => {
        if (role !== "staff" && role !== "unity") {
            console.warn(`⚠️ Rejecting connection from unknown role: ${role}. Disconnecting...`);
            socket.disconnect();
            return;
        }
        setRoleSocket(role, socket);

        // 両クライアントが登録されたら、PWAにWebRTC接続開始を通知
        const staffSocket = getSocket("staff");
        const unitySocket = getSocket("unity");
        if (staffSocket && unitySocket) {
            console.log('🎉 Both clients are ready. Notifying Staff to start WebRTC.');
            staffSocket.emit('start_webrtc');
        } else {
            console.log(`⏳ Waiting for ${staffSocket ? 'Unity' : 'Staff'} client...`);
        }
    });

    socket.on('offer', (offer) => {
        const staffSocket = getSocket('staff');
        const unitySocket = getSocket('unity');
        
        if (socket.id === staffSocket?.id && unitySocket) {
            console.log('➡️ PWAからのOfferを受信。Unityへ転送します。');
            unitySocket.emit('offer', offer);
        } else {
            console.warn(`⚠️ Offer received from unexpected client (${socket.id}). Ignored.`);
        }
    });

    socket.on('answer', (answer) => {
        const staffSocket = getSocket('staff');
        const unitySocket = getSocket('unity');

        if (socket.id === unitySocket?.id && staffSocket) {
            console.log('⬅️ UnityからのAnswerを受信。PWAへ転送します。');
            staffSocket.emit('answer', answer);
        } else {
            console.warn(`⚠️ Answer received from unexpected client (${socket.id}). Ignored.`);
        }
    });

    socket.on('candidate', (candidate) => {
        const staffSocket = getSocket('staff');
        const unitySocket = getSocket('unity');

        if (socket.id === staffSocket?.id && unitySocket) {
            console.log('➡️ PWAからのCandidateを受信。Unityへ転送します。');
            unitySocket.emit('candidate', candidate);
        } else if (socket.id === unitySocket?.id && staffSocket) {
            console.log('⬅️ UnityからのCandidateを受信。PWAへ転送します。');
            staffSocket.emit('candidate', candidate);
        }
    });

    // PWAがWebRTC接続完了を通知するイベント
    socket.on('webrtc_connected', () => {
        console.log(`🎉 WebRTC connection confirmed by PWA (${socket.id}).`);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Socket disconnected: ${socket.id}`);
        let disconnectedRole = null;
        for (const role of ["staff", "unity"]) {
            if (roleSockets[role]?.id === socket.id) {
                roleSockets[role] = null;
                disconnectedRole = role;
                break;
            }
        }
        // 相手のクライアントに切断を通知
        const staffSocket = getSocket("staff");
        const unitySocket = getSocket("unity");
        if (staffSocket) {
            staffSocket.emit("webrtc_close");
            console.log(`Notified Staff client of disconnect.`);
        }
        if (unitySocket) {
            unitySocket.emit("webrtc_close");
            console.log(`Notified Unity client of disconnect.`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});