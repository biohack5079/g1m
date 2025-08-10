// ===== DOM参照 =====
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

// UI要素
const statusElement = document.getElementById('status');
const startFrontBtn = document.getElementById('startFrontCamera');
const startBackBtn = document.getElementById('startBackCamera');
const stopBtn = document.getElementById('stopCamera');

// ===== Socket.IO / WebRTC =====
const socket = io();
let peerConnection = null;
let dataChannel = null;

// MediaPipe関連
let hands = null;
let currentStream = null;
let isHandsReady = false;
let isRunning = false;
let animationFrameId = null;

// WebRTC 状態変数
let iceCandidateBuffer = [];
let isDescriptionSet = false;
let isNegotiating = false; // Offerの重複作成防止

// ===== ステータス表示 =====
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

// ===== MediaPipe Hands初期化 =====
async function initializeHands() {
    try {
        updateStatus('MediaPipe Hands初期化中...', 'loading');
        updateUIState('initializing');

        hands = new Hands({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
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
        console.log('MediaPipe Hands initialized');
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
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {
                color: '#00FF00',
                lineWidth: Math.max(2, canvasElement.width / 320)
            });
            drawLandmarks(canvasCtx, landmarks, {
                color: '#FF0000',
                lineWidth: Math.max(1, canvasElement.width / 480),
                radius: Math.max(2, canvasElement.width / 320)
            });
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

// ===== カメラ制御 =====
async function startCamera(facingMode = 'environment') {
    try {
        await stopCamera(false);
        const constraints = {
            video: {
                facingMode,
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            }
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
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

// ===== WebRTC初期化 =====
function initializeWebRTC() {
    peerConnection?.close();
    dataChannel?.close();
    peerConnection = null;
    dataChannel = null;
    iceCandidateBuffer = [];
    isDescriptionSet = false;

    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    });

    dataChannel = peerConnection.createDataChannel('handData', { ordered: false, maxRetransmits: 0 });
    dataChannel.onopen = () => updateStatus('UnityとWebRTC接続完了', 'success');

    peerConnection.onicecandidate = e => {
        if (e.candidate) {
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
        if (['disconnected', 'failed'].includes(peerConnection.connectionState)) {
            peerConnection?.close();
            dataChannel = null;
            updateStatus('WebRTC接続失敗 - 再試行してください', 'error');
        }
    };

    // Answer受信
    socket.on('answer', async answer => {
        try {
            let parsedAnswer = typeof answer === 'string' ? JSON.parse(answer) : answer;
            if (parsedAnswer.type === 2) parsedAnswer.type = 'answer';
            await peerConnection.setRemoteDescription(new RTCSessionDescription(parsedAnswer));
            isDescriptionSet = true;

            for (const candidate of iceCandidateBuffer) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (err) {
                    console.error('Error adding buffered ICE candidate:', err, candidate);
                }
            }
            iceCandidateBuffer = [];
        } catch (err) {
            console.error('Error setting remote desc:', err);
        }
    });

    // Candidate受信
    socket.on('candidate', async candidate => {
        candidate = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
        if (!candidate || typeof candidate.candidate !== 'string' || !candidate.candidate.trim()) {
            console.warn('Invalid candidate, skipping.');
            return;
        }
        if (candidate.candidate.startsWith('a=')) {
            candidate.candidate = candidate.candidate.substring(2);
        }
        candidate.sdpMid = candidate.sdpMid || '';
        candidate.sdpMLineIndex = candidate.sdpMLineIndex ?? 0;

        if (isDescriptionSet && peerConnection.signalingState === 'stable') {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error('Error adding ICE candidate immediately:', err, candidate);
            }
        } else {
            iceCandidateBuffer.push(candidate);
        }
    });
}

// ===== Socketイベント =====
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

socket.on('connect_error', err => {
    updateStatus('サーバー接続エラー', 'error');
});

socket.on('disconnect', () => {
    updateStatus('サーバー切断', 'error');
    peerConnection?.close();
    dataChannel = null;
});

// ===== UIイベント =====
function setupEventListeners() {
    startFrontBtn.addEventListener('click', () => startCamera('user'));
    startBackBtn.addEventListener('click', () => startCamera('environment'));
    stopBtn.addEventListener('click', () => {
        stopCamera();
        peerConnection?.close();
        dataChannel = null;
    });
    window.addEventListener('resize', handleResize);
    window.addEventListener('beforeunload', () => stopCamera(false));
}

function handleResize() {
    if (isRunning) {
        const rect = videoElement.getBoundingClientRect();
        canvasElement.width = rect.width;
        canvasElement.height = rect.height;
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await initializeHands();
});
