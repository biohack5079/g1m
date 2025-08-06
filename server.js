import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // クロスオリジンアクセスを許可
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 静的ファイルを /public から提供
app.use(express.static(path.join(__dirname, 'public')));

let staffSocket = null;
let unitySocket = null;

io.on('connection', socket => {
  console.log(`🔗 Socket connected: ${socket.id}`);

  // 接続元を識別し、役割を割り当てる
  if (!staffSocket) {
    staffSocket = socket;
    console.log('Staff connected.');
    socket.emit('role', 'staff');
  } else if (!unitySocket) {
    unitySocket = socket;
    console.log('Unity client connected.');
    socket.emit('role', 'unity');
  } else {
    console.log('Connection refused: Maximum clients reached.');
    socket.disconnect();
    return;
  }

  // ★追加: Unityクライアントからの「message」イベントを受信
  socket.on('message', (msg) => {
    console.log(`Received message from ${socket.id}: ${msg}`);
    // 必要であれば、受信したメッセージに応じて応答を返す
    // 例: socket.emit('message', `Server received your message: ${msg}`);
  });

  // シグナリング情報の転送
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
