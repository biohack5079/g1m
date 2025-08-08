// HTMLから要素を取得
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

// UI要素
const statusElement = document.getElementById('status');
// カメラのUIは自動化するため、今回はボタンを非表示にするか、ロジックから削除
// const startFrontBtn = document.getElementById('startFrontCamera');
// const startBackBtn = document.getElementById('startBackCamera');
// const stopBtn = document.getElementById('stopCamera');

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

// --- ステータス・UI関連の関数（変更なし） ---
function updateStatus(message, type = 'loading') {
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
}
function updateUIState(state) {
    // UIの自動化に伴い、この関数はシンプルに。
    switch (state) {
        case 'connecting':
            updateStatus('サーバー接続中...', 'loading');
            break;
        case 'ready_to_connect':
            updateStatus('Unityクライアントを待機中...', 'loading');
            break;
        case 'running':
            updateStatus('カメラ起動＆Unityと接続済み', 'success');
            break;
        case 'error':
            updateStatus('エラーが発生しました', 'error');
            break;
    }
}
// MediaPipe Handsの初期化 (変更なし)
async function initializeHands() {
    try {
        updateStatus('MediaPipe Hands初期化中...', 'loading');
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
        updateStatus('サーバー接続待機中...', 'ready');
        console.log('MediaPipe Hands initialized successfully');
    } catch (error) {
        console.error('MediaPipe Hands初期化エラー:', error);
        updateStatus(`初期化エラー: ${error.message}`, 'error');
    }
}
// onHandsResults関数（変更なし）
function onHandsResults(results) {
    const videoRect = videoElement.getBoundingClientRect();
    canvasElement.width = videoRect.width;
    canvasElement.height = videoRect.height;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
    if (results.multiHandLandmarks) {
        for (const landmarks of results.multiHandLandmarks) {
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: Math.max(2, canvasElement.width / 320) });
            drawLandmarks(canvasCtx, landmarks, { color: '#FF0000', lineWidth: Math.max(1, canvasElement.width / 480), radius: Math.max(2, canvasElement.width / 320) });
        }
        if (dataChannel && dataChannel.readyState === 'open') {
            const handData = JSON.stringify(results.multiHandLandmarks);
            dataChannel.send(handData);
        }
    }
    canvasCtx.restore();
}
// sendToMediaPipe関数（変更なし）
function sendToMediaPipe() {
    if (isRunning && isHandsReady) {
        hands.send({ image: videoElement });
        animationFrameId = requestAnimationFrame(sendToMediaPipe);
    }
}
// カメラを自動で開始する関数
async function startCamera() {
    try {
        updateStatus('カメラ起動中...', 'loading');
        const constraints = {
            video: { 
                facingMode: 'user', // デフォルトで前面カメラ
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
            updateStatus('カメラ起動済み', 'ready');
        };
        console.log('Camera started.');
    } catch (error) {
        console.error('カメラ開始エラー:', error);
        updateStatus(`カメラエラー: ${error.message}`, 'error');
    }
}
// カメラを自動で停止する関数
function stopCamera() {
    isRunning = false;
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
    }
    videoElement.srcObject = null;
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    console.log('Camera stopped.');
}
// --- WebRTC初期化関数 ---
function initializeWebRTC() {
    if (peerConnection) {
        peerConnection.close();
    }
    iceCandidateBuffer = [];
    isDescriptionSet = false;

    console.log('Initializing WebRTC.');
    
    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
        ]
    });

    dataChannel = peerConnection.createDataChannel('handData', {
        ordered: false,
        maxRetransmits: 0
    });
    
    dataChannel.onopen = () => {
        console.log('Data Channel is open!');
        updateStatus('Unityと接続完了', 'success');
    };
    dataChannel.onclose = () => {
        console.log('Data Channel closed');
    };
    dataChannel.onerror = (error) => {
        console.error('Data Channel error:', error);
    };

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
            console.log('Found and sending ICE candidate.');
            socket.emit('candidate', e.candidate);
        }
    };
    
    // PWAがOffererなので、onnegotiationneededでOfferを作成
    peerConnection.onnegotiationneeded = async () => {
        try {
            console.log('onnegotiationneeded triggered. Creating offer...');
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', peerConnection.localDescription);
            isDescriptionSet = true;
            console.log('Offer sent to Unity.');
        } catch (e) {
            console.error('Error creating offer:', e);
        }
    };
    
    peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            console.warn('WebRTC connection failed. Re-initializing...');
            setTimeout(initializeWebRTC, 3000);
        }
    };

    // UnityからのAnswerを受け取った時の処理
    socket.on('answer', async (answer) => {
        console.log('Received answer from Unity client.');
        if (peerConnection && peerConnection.signalingState !== 'closed' && !peerConnection.remoteDescription) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            isDescriptionSet = true;
            console.log('WebRTC answer received and set.');
            
            // バッファ中のICE候補をここで追加
            console.log(`Adding ${iceCandidateBuffer.length} buffered ICE candidates.`);
            for (const candidate of iceCandidateBuffer) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
            iceCandidateBuffer = [];
        }
    });

    // UnityからのICE Candidateを受け取った時の処理
    socket.on('candidate', async (candidate) => {
        console.log('Received ICE candidate from Unity client.');
        if (candidate) {
            if (isDescriptionSet) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('ICE candidate added immediately.');
            } else {
                iceCandidateBuffer.push(candidate);
                console.log('ICE candidate buffered.');
            }
        }
    });
}
// --- メインの実行フロー ---
window.addEventListener('DOMContentLoaded', async (event) => {
    await initializeHands();
    
    // PWAがOffererとなるため、サーバーに役割を通知
    socket.on('connect', () => {
        console.log('Socket connected.');
        socket.emit('register_role', 'staff');
    });

    // サーバーからの開始通知を受け取ったら、カメラとWebRTCを起動
    socket.on('start_webrtc', async () => {
        console.log('Server notified to start WebRTC. Initializing...');
        await startCamera();
        initializeWebRTC();
    });

    socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        stopCamera();
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    });
});