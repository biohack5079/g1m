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

app.use(express.static(path.join(__dirname, 'public')));

let staffSocket = null;
let unitySocket = null;

io.on('connection', socket => {
    console.log(`🔗 Socket connected: ${socket.id}`);

    // クライアントからの役割登録イベントを待つ
    socket.on('register_role', (role) => {
        if (role === 'staff' && !staffSocket) {
            staffSocket = socket;
            console.log('Staff client registered.');
        } else if (role === 'unity' && !unitySocket) {
            unitySocket = socket;
            console.log('Unity client registered.');
        } else {
            console.log(`Connection refused: Role '${role}' is already taken or invalid.`);
            socket.disconnect();
            return;
        }
        
        // 両方のクライアントが揃ったら、PWAに接続開始を通知
        if (staffSocket && unitySocket) {
            console.log('Both clients are ready. Notifying Staff to start WebRTC.');
            staffSocket.emit('start_webrtc'); 
        }
    });

    // PWA (staff)からOfferを受信し、Unityに転送
    socket.on('offer', (offer) => {
        if (socket === staffSocket && unitySocket) {
            console.log(`Offer received from Staff client (${socket.id}). Forwarding to Unity.`);
            unitySocket.emit('offer', offer);
        } else {
            console.log('Offer received from an unexpected client. Ignoring.');
        }
    });

    // UnityからAnswerを受信し、PWA (staff)に転送
    socket.on('answer', (answer) => {
        if (socket === unitySocket && staffSocket) {
            console.log(`Answer received from Unity client (${socket.id}). Forwarding to Staff.`);
            staffSocket.emit('answer', answer);
        } else {
            console.log('Answer received from an unexpected client. Ignoring.');
        }
    });

    // ICE Candidateを双方向で転送
    socket.on('candidate', (candidate) => {
        if (socket === staffSocket && unitySocket) {
            console.log(`Candidate received from Staff client. Forwarding to Unity.`);
            unitySocket.emit('candidate', candidate);
        } else if (socket === unitySocket && staffSocket) {
            console.log(`Candidate received from Unity client. Forwarding to Staff.`);
            staffSocket.emit('candidate', candidate);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
        if (socket === staffSocket) {
            staffSocket = null;
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