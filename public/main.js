// public/main.js

import { Hands } from "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js";
import { Pose } from "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js";
import { Camera } from "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js";
import { drawConnectors, drawLandmarks } from "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js";

const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

const socket = io();
let peerConnection = null;
let dataChannel = null;

// MediaPipe Handsの初期設定
const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});
hands.setOptions({
  maxNumHands: 2,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7
});

// MediaPipe Poseの初期設定
const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
});
pose.setOptions({
  upperBodyOnly: true,
  smoothLandmarks: true,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7
});

let handLandmarks = null;
let poseLandmarks = null;

hands.onResults((results) => {
  handLandmarks = results.multiHandLandmarks;
});

pose.onResults((results) => {
  poseLandmarks = results.poseLandmarks;

  // キャンバスの描画
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
  
  if (poseLandmarks) {
    drawConnectors(canvasCtx, poseLandmarks, Pose.POSE_CONNECTIONS, { color: '#00FF00', lineWidth: 4 });
    drawLandmarks(canvasCtx, poseLandmarks, { color: '#FF0000', lineWidth: 2 });
  }
  if (handLandmarks) {
    for (const landmarks of handLandmarks) {
      drawConnectors(canvasCtx, landmarks, Hands.HAND_CONNECTIONS, { color: '#FF0000', lineWidth: 5 });
      drawLandmarks(canvasCtx, landmarks, { color: '#00FF00', lineWidth: 2 });
    }
  }
  canvasCtx.restore();

  // Data Channelで座標データを送信
  if (dataChannel && dataChannel.readyState === 'open' && (handLandmarks || poseLandmarks)) {
    const payload = JSON.stringify({ hands: handLandmarks, body: poseLandmarks });
    dataChannel.send(payload);
  }
});

// カメラからの映像ストリームをMediaPipeに送る
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await pose.send({ image: videoElement });
  },
  width: 640,
  height: 480
});
camera.start();

// WebRTCシグナリング
socket.on('connect', () => {
  console.log('Socket connected.');
  startWebRTC();
});

function startWebRTC() {
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  dataChannel = peerConnection.createDataChannel('data');
  dataChannel.onopen = () => console.log('Data Channel is open!');

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) socket.emit('candidate', e.candidate);
  };

  peerConnection.createOffer()
    .then(offer => peerConnection.setLocalDescription(offer))
    .then(() => socket.emit('offer', peerConnection.localDescription));
}

socket.on('answer', async (answer) => {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('candidate', async (candidate) => {
  if (candidate) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
});