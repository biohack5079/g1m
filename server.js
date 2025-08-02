// server.js

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

  // シグナリング情報の転送
  socket.on('offer', (offer) => {
    if (socket === staffSocket && unitySocket) {
      unitySocket.emit('offer', offer);
    } else if (socket === unitySocket && staffSocket) {
      staffSocket.emit('offer', offer);
    }
  });

  socket.on('answer', (answer) => {
    if (socket === staffSocket && unitySocket) {
      unitySocket.emit('answer', answer);
    } else if (socket === unitySocket && staffSocket) {
      staffSocket.emit('answer', answer);
    }
  });

  socket.on('candidate', (candidate) => {
    if (socket === staffSocket && unitySocket) {
      unitySocket.emit('candidate', candidate);
    } else if (socket === unitySocket && staffSocket) {
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