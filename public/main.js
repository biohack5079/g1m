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
let animationFrameId = null; // requestAnimationFrameのIDを保持

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

        // Handsの設定
        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        // Handsモデルの処理結果を受け取る
        hands.onResults(onHandsResults);

        // 初期化実行
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
    // キャンバスサイズを動的に調整
    const videoRect = videoElement.getBoundingClientRect();
    canvasElement.width = videoRect.width;
    canvasElement.height = videoRect.height;
    
    // 描画処理
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    if (results.multiHandLandmarks) {
        for (const landmarks of results.multiHandLandmarks) {
            // 接続線を描画
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { 
                color: '#00FF00', 
                lineWidth: Math.max(2, canvasElement.width / 320)
            });
            
            // ランドマークポイントを描画
            drawLandmarks(canvasCtx, landmarks, { 
                color: '#FF0000', 
                lineWidth: Math.max(1, canvasElement.width / 480),
                radius: Math.max(2, canvasElement.width / 320)
            });
        }

        // WebRTCデータチャンネルで手のデータを送信
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

async function startCamera(facingMode = 'user') {
    try {
        const cameraType = facingMode === 'user' ? '前面' : '背面';
        updateStatus(`${cameraType}カメラ開始中...`, 'loading');
        updateUIState('initializing');

        // 既存のリソースをクリーンアップ
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

        // ビデオが再生可能になったらMediaPipeへのフレーム送信を開始
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

// カメラ停止
async function stopCamera(updateUI = true) {
    try {
        isRunning = false;
        
        // requestAnimationFrameを停止
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        // カメラストリームを停止
        if (currentStream) {
            currentStream.getTracks().forEach(track => {
                track.stop();
                console.log(`Stopped track: ${track.kind}`);
            });
            currentStream = null;
        }
        
        // ビデオ要素をクリア
        videoElement.srcObject = null;
        
        // キャンバスをクリア
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

// ウィンドウリサイズ対応
function handleResize() {
    if (isRunning && videoElement.videoWidth && videoElement.videoHeight) {
        const videoRect = videoElement.getBoundingClientRect();
        canvasElement.width = videoRect.width;
        canvasElement.height = videoRect.height;
    }
}

// イベントリスナー設定
function setupEventListeners() {
    startFrontBtn.addEventListener('click', () => startCamera('user'));
    startBackBtn.addEventListener('click', () => startCamera('environment'));
    stopBtn.addEventListener('click', () => stopCamera());
    
    // ウィンドウリサイズ対応
    window.addEventListener('resize', handleResize);
    
    // ページ離脱時のクリーンアップ
    window.addEventListener('beforeunload', () => stopCamera(false));
    
    // 可視性変更時の処理（バックグラウンド時にリソース節約）
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && isRunning) {
            console.log('Page hidden - pausing camera');
        } else if (!document.hidden && isRunning) {
            console.log('Page visible - resuming camera');
        }
    });
}

// DOMのロードが完了してから処理を開始
window.addEventListener('DOMContentLoaded', async (event) => {
    console.log('DOM fully loaded and parsed');
    
    setupEventListeners();
    await initializeHands();
});

// WebRTCシグナリング
socket.on('answer', async (answer) => {
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('WebRTC answer received and set');
    }
});

socket.on('candidate', async (candidate) => {
    if (candidate && peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('ICE candidate added');
    }
});

socket.on('connect', () => {
    console.log('Socket connected. Initializing WebRTC.');

    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    dataChannel = peerConnection.createDataChannel('handData', {
        ordered: false,
        maxRetransmits: 0
    });
    
    dataChannel.onopen = () => {
        console.log('Data Channel is open!');
        updateStatus(statusElement.textContent + ' (WebRTC接続)', 'ready');
    };
    
    dataChannel.onclose = () => {
        console.log('Data Channel closed');
    };
    
    dataChannel.onerror = (error) => {
        console.error('Data Channel error:', error);
    };

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('candidate', e.candidate);
        }
    };
    
    peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC connection state:', peerConnection.connectionState);
    };

    // ★ WebRTCの初期化が完了したことをサーバーに通知
    console.log('WebRTC initialized. Emitting staff_ready event.');
    socket.emit('staff_ready');
});

socket.on('offer', async (offer) => {
    console.log('Received offer:', offer);
    if (peerConnection) {
        console.log('Received offer from Unity client. Creating answer...');
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        
        const answer = await peerConnection.createAnswer();
        console.log('Successfully created answer.');
        await peerConnection.setLocalDescription(answer);
        
        console.log('Sending answer:', peerConnection.localDescription);
        socket.emit('answer', peerConnection.localDescription);
        
        console.log('Answer sent to Unity client');
    }
});

// エラーハンドリング
socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
    updateStatus('サーバー接続エラー', 'error');
});

socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
    updateStatus('サーバー切断', 'error');
});