// --- DOM Elements ---
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

let iceCandidateBuffer = [];
let isDescriptionSet = false;
let isNegotiating = false;

function updateStatus(message, type = 'loading') {
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
}

function updateUIState(state) {
    switch(state) {
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

async function initializeHands() {
    try {
        updateStatus('MediaPipe Hands初期化中...', 'loading');
        updateUIState('initializing');

        hands = new Hands({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
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
    } catch(err) {
        console.error('MediaPipe Hands 初期化エラー:', err);
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

    if(results.multiHandLandmarks) {
        for(const landmarks of results.multiHandLandmarks) {
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color:'#00FF00', lineWidth:2 });
            drawLandmarks(canvasCtx, landmarks, { color:'#FF0000', radius:2 });
        }
        if(dataChannel?.readyState === 'open') {
            dataChannel.send(JSON.stringify(results.multiHandLandmarks));
        }
    }
    canvasCtx.restore();
}

function sendToMediaPipe() {
    if(isRunning && isHandsReady) {
        hands.send({image: videoElement});
        animationFrameId = requestAnimationFrame(sendToMediaPipe);
    }
}

async function startCamera(facingMode='environment') {
    try {
        await stopCamera(false);
        const constraints = {
            video: {
                facingMode: facingMode,
                width: { ideal:1280 },
                height: { ideal:720 },
                frameRate: { ideal:30 }
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
    } catch(err) {
        console.error(`カメラ開始エラー (${facingMode}):`, err);
        updateStatus(`カメラエラー: ${err.message}`, 'error');
        updateUIState('ready');
    }
}

async function stopCamera(updateUI=true) {
    isRunning = false;
    if(animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    currentStream?.getTracks().forEach(track => track.stop());
    currentStream = null;
    videoElement.srcObject = null;
    canvasCtx.clearRect(0,0,canvasElement.width,canvasElement.height);
    if(updateUI) {
        updateStatus('準備完了 - カメラを選択してください', 'ready');
        updateUIState('ready');
    }
}

function initializeWebRTC() {
    peerConnection?.close();
    dataChannel?.close();
    peerConnection = null;
    dataChannel = null;
    iceCandidateBuffer = [];
    isDescriptionSet = false;
    isNegotiating = false;

    peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    dataChannel = peerConnection.createDataChannel('handData', { ordered:false, maxRetransmits:0 });
    dataChannel.onopen = () => updateStatus('UnityとWebRTC接続完了', 'success');
    dataChannel.onclose = () => console.log('Data Channel closed');
    dataChannel.onerror = e => console.error('Data Channel error:', e);

    peerConnection.onicecandidate = e => {
        if(e.candidate) {
            socket.emit('candidate', e.candidate);
        }
    };

    peerConnection.onnegotiationneeded = async () => {
        if(isNegotiating) return;
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
        if(['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
            peerConnection?.close();
            dataChannel = null;
            updateStatus('WebRTC接続失敗または切断', 'error');
        }
    };

    socket.on('answer', async answer => {
        try {
            if(!peerConnection) return;
            let parsed = typeof answer === 'string' ? JSON.parse(answer) : answer;
            if(parsed.type === 2) parsed.type = 'answer';
            else if(parsed.type === 1) parsed.type = 'offer';

            if(peerConnection.signalingState === 'have-local-offer' || peerConnection.signalingState === 'have-remote-offer') {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(parsed));
                isDescriptionSet = true;

                for(let cand of iceCandidateBuffer) {
                    try {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
                    } catch(err) {
                        console.error('バッファ候補追加失敗:', err, cand);
                    }
                }
                iceCandidateBuffer = [];
            } else {
                console.warn('setRemoteDescriptionを呼べる状態にありません。状態:', peerConnection.signalingState);
            }
        } catch(err) {
            console.error('answer設定エラー:', err);
        }
    });

    socket.on('candidate', async candidate => {
        try {
            if(!candidate) {
                console.warn('candidateが空です。スキップします。');
                return;
            }
            let parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
            
            if(!parsed.candidate || typeof parsed.candidate !== 'string' || !parsed.candidate.trim()) {
                console.warn('不正なcandidateをスキップ:', parsed);
                return;
            }

            if(parsed.candidate.startsWith('a=')) parsed.candidate = parsed.candidate.substring(2);
            parsed.sdpMid = parsed.sdpMid || '';
            parsed.sdpMLineIndex = parsed.sdpMLineIndex ?? 0;

            if(isDescriptionSet && peerConnection.signalingState === 'stable') {
                await peerConnection.addIceCandidate(new RTCIceCandidate(parsed));
            } else {
                iceCandidateBuffer.push(parsed);
            }
        } catch(err) {
            console.error('candidate処理エラー:', err, candidate);
        }
    });
}

socket.on('connect', () => {
    socket.emit('register_role', 'staff');
    updateStatus('Unityクライアントを待機中...', 'loading');
});

socket.on('start_webrtc', async () => {
    if(!isRunning) await startCamera('environment'); // 背面カメラをデフォルト起動
    initializeWebRTC();
});

socket.on('webrtc_close', () => {
    stopCamera();
    peerConnection?.close();
    dataChannel = null;
    updateStatus('WebRTC接続が切断されました', 'error');
});

socket.on('connect_error', err => updateStatus('サーバー接続エラー', 'error'));
socket.on('disconnect', () => {
    updateStatus('サーバー切断', 'error');
    peerConnection?.close();
    dataChannel = null;
});

function setupEventListeners() {
    startFrontBtn.addEventListener('click', () => startCamera('user'));
    startBackBtn.addEventListener('click', () => startCamera('environment'));
    stopBtn.addEventListener('click', () => {
        stopCamera();
        peerConnection?.close();
        dataChannel = null;
    });
    window.addEventListener('resize', () => {
        if(isRunning) {
            const rect = videoElement.getBoundingClientRect();
            canvasElement.width = rect.width;
            canvasElement.height = rect.height;
        }
    });
    window.addEventListener('beforeunload', () => stopCamera(false));
    document.addEventListener('visibilitychange', () => {
        if(document.hidden && isRunning) {
            console.log('Page hidden - pausing camera');
        } else if(!document.hidden && isRunning) {
            console.log('Page visible - resuming camera');
        }
    });
}

window.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await initializeHands();
});
