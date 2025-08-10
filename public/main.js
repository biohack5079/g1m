// ====== 初期化 ======
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

const statusElement = document.getElementById('status');
const startFrontBtn = document.getElementById('startFrontCamera');
const startBackBtn = document.getElementById('startBackCamera');
const stopBtn = document.getElementById('stopCamera');

const socket = io();
let peerConnection = null;
let dataChannel = null;

let hands = null;
let currentStream = null;
let isHandsReady = false;
let isRunning = false;
let animationFrameId = null;

// WebRTC状態
let iceCandidateBuffer = [];
let isDescriptionSet = false;
let isNegotiating = false;

// ====== ユーティリティ ======
function updateStatus(message, type = 'loading') {
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
}

function updateUIState(state) {
    switch (state) {
        case 'initializing':
            startFrontBtn.disabled = true;
            startBackBtn.disabled = true;
            stopBtn.classList.add('hidden');
            break;
        case 'ready':
            startFrontBtn.disabled = false;
            startBackBtn.disabled = false;
            stopBtn.classList.add('hidden');
            break;
        case 'running':
            startFrontBtn.disabled = true;
            startBackBtn.disabled = false;
            stopBtn.classList.remove('hidden');
            break;
    }
}

// ====== MediaPipe Hands ======
async function initializeHands() {
    try {
        updateStatus('MediaPipe Hands初期化中...', 'loading');
        updateUIState('initializing');

        hands = new Hands({
            locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });
        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });
        hands.onResults(onHandsResults);
        await hands.initialize();

        isHandsReady = true;
        updateStatus('準備完了 - カメラを選択してください', 'ready');
        updateUIState('ready');
    } catch (err) {
        console.error('MediaPipe Hands初期化エラー:', err);
        updateStatus(`初期化エラー: ${err.message}`, 'error');
    }
}

function onHandsResults(results) {
    const videoRect = videoElement.getBoundingClientRect();
    canvasElement.width = videoRect.width;
    canvasElement.height = videoRect.height;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    if (results.multiHandLandmarks) {
        for (const landmarks of results.multiHandLandmarks) {
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 2 });
            drawLandmarks(canvasCtx, landmarks, { color: '#FF0000', radius: 2 });
        }
        if (dataChannel?.readyState === 'open') {
            dataChannel.send(JSON.stringify(results.multiHandLandmarks));
        }
    }
    canvasCtx.restore();
}

function sendToMediaPipe() {
    if (isRunning && isHandsReady) {
        hands.send({ image: videoElement });
        animationFrameId = requestAnimationFrame(sendToMediaPipe);
    }
}

// ====== カメラ ======
async function startCamera(facingMode = 'environment') {
    try {
        await stopCamera(false);
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode,
                width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }
            }
        });
        videoElement.srcObject = stream;
        currentStream = stream;
        isRunning = true;
        videoElement.onloadeddata = () => {
            videoElement.play();
            sendToMediaPipe();
            updateStatus(`${facingMode === 'user' ? '前面' : '背面'}カメラで動作中`, 'ready');
            updateUIState('running');
        };
    } catch (err) {
        console.error(`カメラ開始エラー (${facingMode}):`, err);
        updateStatus(`カメラエラー: ${err.message}`, 'error');
        updateUIState('ready');
    }
}

async function stopCamera(updateUI = true) {
    isRunning = false;
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    currentStream?.getTracks().forEach(track => track.stop());
    currentStream = null;
    videoElement.srcObject = null;
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    if (updateUI) {
        updateStatus('準備完了 - カメラを選択してください', 'ready');
        updateUIState('ready');
    }
}

// ====== WebRTC ======
function initializeWebRTC() {
    peerConnection?.close();
    dataChannel?.close();
    peerConnection = null;
    dataChannel = null;
    iceCandidateBuffer = [];
    isDescriptionSet = false;
    isNegotiating = false;

    peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    dataChannel = peerConnection.createDataChannel('handData', { ordered: false, maxRetransmits: 0 });
    dataChannel.onopen = () => updateStatus('UnityとWebRTC接続完了', 'success');

    peerConnection.onicecandidate = e => {
        if (e.candidate) {
            console.log('Send candidate:', e.candidate);
            socket.emit('candidate', e.candidate);
        }
    };

    peerConnection.onnegotiationneeded = async () => {
        if (isNegotiating) return;
        isNegotiating = true;
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', peerConnection.localDescription);
        } finally {
            isNegotiating = false;
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
            peerConnection?.close();
            dataChannel = null;
        }
    };

    // ---- Answer受信 ----
    socket.on('answer', async answer => {
        try {
            let parsed = typeof answer === 'string' ? JSON.parse(answer) : answer;
            if (parsed.type === 2) parsed.type = 'answer'; // Unity numeric type対応
            await peerConnection.setRemoteDescription(new RTCSessionDescription(parsed));
            isDescriptionSet = true;

            // バッファ追加分を一括処理
            for (const cand of iceCandidateBuffer) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
                } catch (err) {
                    console.error('Buffered ICE candidate error:', err, cand);
                }
            }
            iceCandidateBuffer = [];
        } catch (err) {
            console.error('Set remote desc error:', err);
        }
    });

    // ---- Candidate受信 ----
    socket.on('candidate', async candidate => {
        try {
            let parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
            if (!parsed || typeof parsed.candidate !== 'string' || !parsed.candidate.trim()) {
                console.warn('Invalid ICE candidate, skipping', parsed);
                return;
            }
            if (parsed.candidate.startsWith('a=')) {
                parsed.candidate = parsed.candidate.substring(2);
            }
            parsed.sdpMid = parsed.sdpMid || '';
            parsed.sdpMLineIndex = parsed.sdpMLineIndex ?? 0;

            if (isDescriptionSet && peerConnection.signalingState === 'stable') {
                await peerConnection.addIceCandidate(new RTCIceCandidate(parsed));
            } else {
                iceCandidateBuffer.push(parsed);
            }
        } catch (err) {
            console.error('Error processing candidate:', err, candidate);
        }
    });
}

// ====== Socket.io ======
socket.on('connect', () => {
    socket.emit('register_role', 'staff');
    updateStatus('Unityクライアントを待機中...', 'loading');
});

socket.on('start_webrtc', async () => {
    if (!isRunning) await startCamera('user');
    initializeWebRTC();
});

socket.on('webrtc_close', () => {
    stopCamera();
    peerConnection?.close();
    dataChannel = null;
    updateStatus('WebRTC接続が切断されました', 'error');
});

// ====== UIイベント ======
function setupEventListeners() {
    startFrontBtn.addEventListener('click', () => startCamera('user'));
    startBackBtn.addEventListener('click', () => startCamera('environment'));
    stopBtn.addEventListener('click', () => {
        stopCamera();
        peerConnection?.close();
        dataChannel = null;
    });
}

window.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await initializeHands();
});
