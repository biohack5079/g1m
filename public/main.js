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
            startBackBtn.disabled = true;
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
            // ★ 修正箇所: JSON配列をラッパーオブジェクトで囲んでから送信
            const dataWrapper = {
                multiHandLandmarks: results.multiHandLandmarks
            };
            const handData = JSON.stringify(dataWrapper);
            dataChannel.send(handData);
            console.log('✅ Sent hand data to Unity via DataChannel.');
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
            updateStatus(`${cameraType}カメラで動作中`, 'running');
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

        console.log('Camera stopped successfully');

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
        initializeWebRTC();
    });
    startBackBtn.addEventListener('click', async () => {
        await startCamera('environment');
        initializeWebRTC();
    });
    stopBtn.addEventListener('click', () => {
        stopCamera();
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
            socket.emit('webrtc_close');
        }
        dataChannel = null;
    });

    window.addEventListener('resize', handleResize);
    window.addEventListener('beforeunload', () => stopCamera(false));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && isRunning) {
            console.log('Page hidden - pausing camera');
        } else if (!document.hidden && isRunning) {
            console.log('Page visible - resuming camera');
        }
    });
}

window.addEventListener('DOMContentLoaded', async (event) => {
    console.log('DOM fully loaded and parsed');
    setupEventListeners();
    await initializeHands();
});

// PWAがWebRTC接続を開始するロジック
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

    dataChannel.onclose = () => {
        console.log('Data Channel closed');
    };

    dataChannel.onerror = (error) => {
        console.error('Data Channel error:', error);
    };

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
            console.log('Found and sending ICE candidate:', JSON.stringify(e.candidate));

            let candidateStr = e.candidate.candidate;
            candidateStr = candidateStr.replace(/\sufrag\s\S+/, '');
            candidateStr = candidateStr.replace(/\snetwork-id\s\S+/, '');
            
            const candidateObj = {
                candidate: candidateStr,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex,
            };
            
            socket.emit('candidate', candidateObj);
            console.log('✅ PWAから送信するCandidate JSON (修正後):', candidateObj);
        }
    };

    peerConnection.onnegotiationneeded = async () => {
        console.log('Negotiation needed event fired. Creating and sending Offer.');
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            
            const offerObj = {
                type: 'offer',
                sdp: peerConnection.localDescription.sdp,
            };
            socket.emit('offer', offerObj);
            
            isDescriptionSet = false;
            console.log('PWA created and sent offer.');
        } catch (e) {
            console.error('Error creating and sending offer:', e);
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            stopCamera();
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            dataChannel = null;
            updateStatus('WebRTC接続失敗 - 再試行してください', 'error');
        }
    };

    socket.on('answer', async (answer) => {
        console.log('💙 UnityからAnswerを受信しました。');

        let answerObj = answer;
        if (typeof answer === 'string') {
            try {
                answerObj = JSON.parse(answer);
            } catch (e) {
                console.error('Error parsing answer JSON:', e);
                return;
            }
        }
        
        console.log('✅ 受信したAnswer JSON:', answerObj);
        
        if (peerConnection && peerConnection.signalingState === 'have-local-offer' &&
            answerObj && answerObj.sdp && answerObj.type === 'answer') {
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answerObj));
                isDescriptionSet = true;
                for (const candidate of iceCandidateBuffer) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
                iceCandidateBuffer = [];
                console.log('Successfully set remote description and added buffered candidates.');
            } catch (e) {
                console.error('Error setting remote description for answer:', e);
            }
        } else {
            console.error('Invalid state or answer object:', peerConnection?.signalingState, answerObj);
        }
    });

    socket.on('candidate', async (candidate) => {
        console.log('💙 UnityからCandidateを受信しました。');

        let candidateObj = candidate;
        if (typeof candidate === 'string') {
            try {
                candidateObj = JSON.parse(candidate);
            } catch (e) {
                console.error('Error parsing candidate JSON:', e);
                return;
            }
        }
        
        console.log('✅ 受信したCandidate JSON:', candidateObj);

        if (candidateObj && candidateObj.candidate) {
            if (isDescriptionSet) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidateObj));
                    console.log('ICE candidate added immediately.');
                } catch (e) {
                    console.error('Error adding received ICE candidate immediately:', e);
                }
            } else {
                iceCandidateBuffer.push(candidateObj);
                console.log('ICE candidate buffered.');
            }
        } else {
            console.error('Received invalid ICE candidate object:', candidateObj);
        }
    });
}

// Socket.IO接続イベント
socket.on('connect', () => {
    socket.emit('register_role', 'staff');
    updateStatus('Unityクライアントを待機中...', 'loading');
});

socket.on('webrtc_close', () => {
    stopCamera();
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannel = null;
    updateStatus('WebRTC接続が切断されました', 'error');
});

socket.on('connect_error', (error) => {
    updateStatus('サーバー接続エラー', 'error');
});

socket.on('disconnect', (reason) => {
    updateStatus('サーバー切断', 'error');
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannel = null;
});