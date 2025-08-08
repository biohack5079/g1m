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
        if (role === 'staff') {
            staffSocket = socket;
            console.log('Staff client registered.');
        } else if (role === 'unity') {
            unitySocket = socket;
            console.log('Unity client registered.');
        } else {
            console.log(`Connection refused: Role '${role}' is invalid.`);
            socket.disconnect();
            return;
        }
    });

    // PWA (staff)からOfferを受信し、Unityに転送
    socket.on('offer', (offer) => {
        console.log(`Offer received from Staff client (${socket.id}).`);
        if (unitySocket) {
            console.log('Forwarding offer to Unity client.');
            unitySocket.emit('offer', offer);
        } else {
            console.log('Unity client is not connected. Cannot forward offer.');
        }
    });

    // UnityからAnswerを受信し、PWA (staff)に転送
    socket.on('answer', (answer) => {
        console.log(`Answer received from Unity client (${socket.id}).`);
        if (staffSocket) {
            console.log('Forwarding answer to Staff client.');
            staffSocket.emit('answer', answer);
        } else {
            console.log('Staff client is not connected. Cannot forward answer.');
        }
    });

    // ICE Candidateを双方向で転送
    socket.on('candidate', (candidate) => {
        console.log(`Candidate received from ${socket.id}`);
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