import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
    },
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

    // クライアントが役割を自己申告するのを待つ
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

        // 両方のクライアントが接続・登録されたら、PWAに接続開始を通知
        if (staffSocket && unitySocket) {
            console.log('Both clients are ready. Notifying Staff to start WebRTC.');
            staffSocket.emit('start_webrtc'); 
        }
    });

    socket.on('offer', (offer) => {
        // PWA (staff)からOfferを受信し、Unityに転送
        console.log(`Offer received from Staff client (${socket.id}).`);
        if (socket === staffSocket && unitySocket) {
            console.log('Forwarding offer to Unity client.');
            unitySocket.emit('offer', offer);
        } else {
            console.log('Offer received from an unexpected client. Ignoring.');
        }
    });

    socket.on('answer', (answer) => {
        // UnityからAnswerを受信し、PWA (staff)に転送
        console.log(`Answer received from Unity client (${socket.id}).`);
        if (socket === unitySocket && staffSocket) {
            console.log('Forwarding answer to Staff client.');
            staffSocket.emit('answer', answer);
        } else {
            console.log('Answer received from an unexpected client. Ignoring.');
        }
    });

    socket.on('candidate', (candidate) => {
        console.log(`Candidate received from ${socket.id}`);
        // どちらのクライアントからのCandidateも、もう一方に転送
        if (socket === staffSocket && unitySocket) {
            console.log('Forwarding candidate from Staff to Unity.');
            unitySocket.emit('candidate', candidate);
        } else if (socket === unitySocket && staffSocket) {
            console.log('Forwarding candidate from Unity to Staff.');
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
        // 片方が切断されたら、もう一方もWebRTC接続を終了させるために通知
        if (staffSocket) {
            staffSocket.emit('webrtc_close');
        }
        if (unitySocket) {
            unitySocket.emit('webrtc_close');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});