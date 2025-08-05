// HTMLから要素を取得
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

// Socket.IOとWebRTCの初期化
const socket = io();
let peerConnection = null;
let dataChannel = null;
let isHandsInitialized = false;

// DOMのロードが完了してから処理を開始
window.addEventListener('DOMContentLoaded', (event) => {
  console.log('DOM fully loaded and parsed');

  // Handsモデルの初期化
  const hands = new Hands({
    locateFile: (file) => {
      return `/mediapipe/hands/${file}`;
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
  
    // ... (以下、元の onResults の中身をそのまま配置) ...
  });

  // カメラからの映像ストリームをMediaPipeに送る
  const camera = new Camera(videoElement, {
    onFrame: async () => {
      await hands.send({ image: videoElement });
    },
    width: 640,
    height: 480
  });

  // Handsモデルの起動
  hands.initialize().then(() => {
    // initialize() が成功したらコンソールに表示
    console.log('Hands model initialized successfully and ready to use.');
  }).catch((error) => {
    // エラーが発生した場合のログ
    console.error('Failed to initialize Hands model:', error);
  });
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