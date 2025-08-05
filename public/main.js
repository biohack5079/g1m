// HTMLから要素を取得
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

// Socket.IOとWebRTCの初期化
const socket = io();
let peerConnection = null;
let dataChannel = null;
let isHandsInitialized = false;

// Handsモデルの初期化
const hands = new Hands({
  locateFile: (file) => {
    // バージョンを固定し、安定性を確保
    return `../node_modules/@mediapipe/hands/${file}`;
  }
});

let handLandmarks = null;

// Handsモデルの処理結果を受け取る
hands.onResults((results) => {
  // 初期化完了のログ
  if (!isHandsInitialized) {
    console.log("Hands model initialized successfully.");
    isHandsInitialized = true;
    camera.start(); // モデル初期化後にカメラを起動
  }

  handLandmarks = results.multiHandLandmarks;

  // キャンバスの描画
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
  
  if (handLandmarks) {
    for (const landmarks of handLandmarks) {
      drawConnectors(canvasCtx, landmarks, Hands.HAND_CONNECTIONS, { color: '#FF0000', lineWidth: 5 });
      drawLandmarks(canvasCtx, landmarks, { color: '#00FF00', lineWidth: 2 });
    }
  }
  canvasCtx.restore();

  // Data Channelで座標データを送信
  if (dataChannel && dataChannel.readyState === 'open' && handLandmarks) {
    const payload = JSON.stringify({ hands: handLandmarks });
    dataChannel.send(payload);
  }
});

// カメラからの映像ストリームをMediaPipeに送る
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await hands.send({ image: videoElement });
  },
  width: 640,
  height: 480
});

// WebRTCシグナリング
socket.on('answer', async (answer) => {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on('candidate', async (candidate) => {
  if (candidate && peerConnection) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

socket.on('connect', () => {
  console.log('Socket connected. Initializing WebRTC.');

  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  dataChannel = peerConnection.createDataChannel('data');
  dataChannel.onopen = () => console.log('Data Channel is open!');

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) socket.emit('candidate', e.candidate);
  };
});

socket.on('offer', async (offer) => {
  if (peerConnection) {
    console.log('Received an offer from Unity client. Creating an answer.');
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer', peerConnection.localDescription);
  }
});