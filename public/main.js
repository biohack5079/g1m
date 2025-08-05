// HTMLから要素を取得
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const cameraToggleButton = document.getElementById('camera-toggle-btn');

// Socket.IOとWebRTCの初期化
const socket = io();
let peerConnection = null;
let dataChannel = null;
let hands = null;
let camera = null;
let currentFacingMode = 'environment'; // デフォルトは背面カメラ

// Handsモデルの処理結果を受け取る
const onResults = (results) => {
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

  if (results.multiHandLandmarks) {
    for (const landmarks of results.multiHandLandmarks) {
      drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 5 });
      drawLandmarks(canvasCtx, landmarks, { color: '#FF0000', lineWidth: 2 });
    }

    if (dataChannel && dataChannel.readyState === 'open') {
      const handData = JSON.stringify(results.multiHandLandmarks);
      dataChannel.send(handData);
    }
  }
  canvasCtx.restore();
};

// カメラを起動/再起動する関数
const startCamera = (facingMode) => {
  if (camera) {
    camera.stop();
  }

  camera = new Camera(videoElement, {
    onFrame: async () => {
      await hands.send({ image: videoElement });
    },
    width: 640,
    height: 480,
    video: {
      facingMode: facingMode
    }
  });

  camera.start();
};

// DOMのロードが完了してから処理を開始
window.addEventListener('DOMContentLoaded', (event) => {
  console.log('DOM fully loaded and parsed');

  hands = new Hands({
    // locateFileの記述を削除
  });
  
  hands.onResults(onResults);

  hands.initialize().then(() => {
    console.log('Hands model initialized successfully and ready to use.');
    // 初期化が完了したら、デフォルトで背面カメラを起動
    startCamera(currentFacingMode);
  }).catch((error) => {
    console.error('Failed to initialize Hands model:', error);
  });

  // ボタンのイベントリスナー
  cameraToggleButton.addEventListener('click', () => {
    // 現在のカメラの向きを切り替え
    if (currentFacingMode === 'environment') {
      currentFacingMode = 'user';
      cameraToggleButton.textContent = '背面カメラに切り替え';
    } else {
      currentFacingMode = 'environment';
      cameraToggleButton.textContent = '前面カメラに切り替え';
    }
    // 新しい向きでカメラを起動
    startCamera(currentFacingMode);
  });
});

// WebRTCシグナリング (変更なし)
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