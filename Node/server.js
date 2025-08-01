const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const cors = require('cors');

app.use(cors());
app.use(express.static('public'));

io.on('connection', socket => {
  console.log('User connected');
  socket.on('video-frame', (data) => {
    // ここでFlaskに渡してMediaPipeに送る処理を入れる
    // 例: fetch('http://localhost:5000/handtrack', {...})
  });
});

http.listen(3000, () => {
  console.log('Node.js server running on http://localhost:3000');
});
