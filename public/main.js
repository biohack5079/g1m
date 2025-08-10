// HTMLから要素を取得
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

// UI要素
const statusElement = document.getElementById('status');
const startFrontBtn = document.getElementById('startFrontCamera');
const startBackBtn = document.getElementById('startBackCamera');
const stopBtn = document.getElementById('stopCamera');

// Socket.IOとWebRTCの初期化
const socket = io();
let peerConnection = null;
let dataChannel = null;

// MediaPipe関連
let hands = null;
let currentStream = null;
let isHandsReady = false;
let isRunning = false;
let animationFrameId = null; 

// WebRTCの追加変数
let iceCandidateBuffer = [];
let isDescriptionSet = false;

// ステータス更新関数
function updateStatus(message, type = 'loading') {
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
}

// UI状態更新
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

// MediaPipe Handsの初期化
async function initializeHands() {
    try {
        updateStatus('MediaPipe Hands初期化中...', 'loading');
        updateUIState('initializing');

        hands = new Hands({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
            }
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
        
        console.log('MediaPipe Hands initialized successfully');
        
    } catch (error) {
        console.error('MediaPipe Hands初期化エラー:', error);
        updateStatus(`初期化エラー: ${error.message}`, 'error');
    }
}

// 手のランドマーク処理結果
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

        if (dataChannel && dataChannel.readyState === 'open') {
            const handData = JSON.stringify(results.multiHandLandmarks);
            dataChannel.send(handData);
        }
    }
    
    canvasCtx.restore();
}

// フレームをMediaPipeに送信するループ
function sendToMediaPipe() {
    if (isRunning && isHandsReady) {
        hands.send({ image: videoElement });
        animationFrameId = requestAnimationFrame(sendToMediaPipe);
    }
}

async function startCamera(facingMode = 'environment') {
    try {
        const cameraType = facingMode === 'user' ? '前面' : '背面';
        updateStatus(`${cameraType}カメラ開始中...`, 'loading');
        updateUIState('initializing');

        await stopCamera(false);

        const constraints = {
            video: {
                facingMode: facingMode,
                width: { ideal: 1280, max: 1920 },
                height: { ideal: 720, max: 1080 },
                frameRate: { ideal: 30, max: 60 }
            }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        videoElement.srcObject = stream;
        currentStream = stream;
        isRunning = true;

        videoElement.onloadeddata = () => {
            console.log('Video stream loaded.');
            videoElement.play();
            sendToMediaPipe();
            updateStatus(`${cameraType}カメラで動作中`, 'ready');
            updateUIState('running');
        };

        console.log(`Camera started with ${cameraType} facing mode`);

    } catch (error) {
        console.error(`カメラ開始エラー (${facingMode}):`, error);
        updateStatus(`カメラエラー: ${error.message}`, 'error');
        updateUIState('ready');
    }
}

async function stopCamera(updateUI = true) {
    try {
        isRunning = false;
        
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        if (currentStream) {
            currentStream.getTracks().forEach(track => {
                track.stop();
                console.log(`Stopped track: ${track.kind}`);
            });
            currentStream = null;
        }
        
        videoElement.srcObject = null;
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        
        if (updateUI) {
            updateStatus('準備完了 - カメラを選択してください', 'ready');
            updateUIState('ready');
        }
        
    } catch (error) {
        console.error('カメラ停止エラー:', error);
    }
}

function handleResize() {
    if (isRunning && videoElement.videoWidth && videoElement.videoHeight) {
        const videoRect = videoElement.getBoundingClientRect();
        canvasElement.width = videoRect.width;
        canvasElement.height = videoRect.height;
    }
}

function setupEventListeners() {
    startFrontBtn.addEventListener('click', async () => {
        await startCamera('user');
    });
    startBackBtn.addEventListener('click', async () => {
        await startCamera('environment');
    });
    stopBtn.addEventListener('click', () => {
        stopCamera();
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        dataChannel = null;
    });
    
    window.addEventListener('resize', handleResize);
    window.addEventListener('beforeunload', () => stopCamera(false));
}

// ページ読み込み後に初期化
window.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM fully loaded and parsed');
    setupEventListeners();
    await initializeHands();
});

// WebRTC初期化関数
function initializeWebRTC() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    
    iceCandidateBuffer = [];
    isDescriptionSet = false;

    console.log('Initializing WebRTC.');

    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun.services.mozilla.com:3478' },
            { urls: 'stun:stun.voip.blackberry.com:3478' }
        ]
    });
    
    dataChannel = peerConnection.createDataChannel('handData', {
        ordered: false,
        maxRetransmits: 0
    });
    
    dataChannel.onopen = () => {
        console.log('Data Channel is open!');
        updateStatus('UnityとWebRTC接続完了', 'success');
    };

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
            console.log('Found and sending ICE candidate:', JSON.stringify(e.candidate));
            socket.emit('candidate', e.candidate);
        }
    };
    
    peerConnection.onnegotiationneeded = async () => {
        try {
            console.log('Creating offer...');
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', peerConnection.localDescription);
            console.log('💙 Offer sent to server.');
            isDescriptionSet = true;
        } catch (e) {
            console.error('Error creating offer:', e);
        }
    };

    // UnityからのAnswer処理
    socket.on('answer', async (answer) => {
        console.log('💙 UnityからAnswerを受信しました。');
        if (peerConnection && peerConnection.signalingState !== 'closed') {
            try {
                let parsedAnswer = typeof answer === 'string' ? JSON.parse(answer) : answer;
                if (parsedAnswer.sdp && parsedAnswer.type) {
                    if (parsedAnswer.type === 2) parsedAnswer.type = 'answer';
                    else if (parsedAnswer.type === 1) parsedAnswer.type = 'offer';
                }
                await peerConnection.setRemoteDescription(new RTCSessionDescription(parsedAnswer));
                isDescriptionSet = true;
                console.log('💙 Answerをリモート記述に設定しました。');

                for (const candidate of iceCandidateBuffer) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
                iceCandidateBuffer = [];
            } catch (e) {
                console.error('Error setting remote description or adding ICE candidates:', e);
            }
        }
    });

    // ★ 修正版 candidate 受信処理
    socket.on('candidate', async (candidate) => {
        console.log('💙 UnityからCandidateを受信しました。');
        if (candidate) {
            let parsedCandidate = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;

            let sdpCandidate = parsedCandidate.candidate || parsedCandidate;
            if (typeof sdpCandidate === 'string' && sdpCandidate.startsWith("a=")) {
                console.log("Trimming 'a=' prefix from candidate string.");
                sdpCandidate = sdpCandidate.substring(2);
            }

            const finalCandidate = {
                candidate: sdpCandidate,
                sdpMid: parsedCandidate.sdpMid !== undefined ? parsedCandidate.sdpMid : '',
                sdpMLineIndex: parsedCandidate.sdpMLineIndex !== undefined ? parsedCandidate.sdpMLineIndex : 0
            };

            if (isDescriptionSet) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(finalCandidate));
                    console.log('ICE candidate added immediately.');
                } catch (e) {
                    console.error('Error adding received ICE candidate immediately:', e);
                }
            } else {
                iceCandidateBuffer.push(finalCandidate);
                console.log('ICE candidate buffered.');
            }
        }
    });
}

// 接続イベント
socket.on('connect', () => {
    console.log('Socket connected.');
    socket.emit('register_role', 'staff');
    updateStatus('Unityクライアントを待機中...', 'loading');
});

socket.on('start_webrtc', async () => {
    console.log('Received start_webrtc from server.');
    if (!isRunning) {
        await startCamera('user');
    }
    initializeWebRTC();
});

socket.on('webrtc_close', () => {
    console.log('Received webrtc_close.');
    stopCamera();
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannel = null;
    updateStatus('WebRTC接続が切断されました', 'error');
});

socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
    updateStatus('サーバー接続エラー', 'error');
});

socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
    updateStatus('サーバー切断', 'error');
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannel = null;
});
