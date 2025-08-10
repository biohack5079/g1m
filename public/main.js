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
            startBackBtn.disabled = false; // 背面カメラは動作中のままにする
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
                facingMode: facingMode, // ここで引数として渡された facingMode を使用
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
        // WebRTC接続もクリーンアップ
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
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

// PWAがOffererとなり、WebRTC接続プロセスを開始する関数
// サーバーからのstart_webrtcイベントを受信したときに呼び出される
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
    
    // DataChannelをPWAが作成
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
            socket.emit('candidate', e.candidate);
        }
    };
    
    // NegotiationNeededイベントでOfferを作成・送信
    peerConnection.onnegotiationneeded = async () => {
        try {
            console.log('onnegotiationneeded triggered. Creating offer...');
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', peerConnection.localDescription);
            console.log('💙 Offerを作成し、サーバーに送信しました。');
            isDescriptionSet = true;
            console.log('Offer sent to server.');
        } catch (e) {
            console.error('Error creating offer:', e);
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            console.warn('WebRTC connection failed or disconnected. Closing peer connection.');
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            dataChannel = null;
            updateStatus('WebRTC接続失敗 - 再試行してください', 'error');
        } else if (peerConnection.connectionState === 'closed') {
            console.log('WebRTC connection has been closed.');
            updateStatus('WebRTC接続が切断されました', 'error');
        }
    };

    // UnityからのAnswerを受信した時の処理
    socket.on('answer', async (answer) => {
        console.log('Received answer from Unity client.');
        console.log('💙 UnityからAnswerを受信しました。');
        if (peerConnection && peerConnection.signalingState !== 'closed') {
            try {
                let parsedAnswer = typeof answer === 'string' ? JSON.parse(answer) : answer;
                
                // ★修正: UnityのWebRTCライブラリの形式に合わせてSdpとtypeをパース
                if (parsedAnswer.sdp && parsedAnswer.type) {
                    // typeが数値の場合は文字列に変換
                    if (parsedAnswer.type === 2) {
                        parsedAnswer.type = 'answer';
                    } else if (parsedAnswer.type === 1) {
                        parsedAnswer.type = 'offer';
                    }
                }
                
                await peerConnection.setRemoteDescription(new RTCSessionDescription(parsedAnswer));
                isDescriptionSet = true;
                console.log('WebRTC answer received and set.');
                console.log('💙 Answerをリモート記述に設定しました。');
                
                // バッファ中のICE候補をここで追加
                console.log(`Adding ${iceCandidateBuffer.length} buffered ICE candidates.`);
                for (const candidate of iceCandidateBuffer) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
                iceCandidateBuffer = [];
            } catch (e) {
                console.error('Error setting remote description or adding ICE candidates:', e);
            }
        }
    });

    socket.on('candidate', async (candidate) => {
        console.log('Received ICE candidate from Unity client.');
        console.log('💙 UnityからCandidateを受信しました。');

        if (!candidate) {
            console.warn('Candidate is null or undefined, skipping.');
            return;
        }

        let parsedCandidate;
        try {
            parsedCandidate = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
        } catch (err) {
            console.error('Failed to parse candidate JSON:', err, candidate);
            return;
        }

        let sdpCandidate = parsedCandidate.candidate || parsedCandidate;
        if (!sdpCandidate || sdpCandidate === 'null') {
            console.warn('Empty or null candidate string, skipping addIceCandidate.');
            return;
        }

        if (typeof sdpCandidate === 'string' && sdpCandidate.startsWith('a=')) {
            console.log("Trimming 'a=' prefix from candidate string.");
            sdpCandidate = sdpCandidate.substring(2);
        }

        const finalCandidate = {
            candidate: sdpCandidate,
            sdpMid: parsedCandidate.sdpMid !== undefined && parsedCandidate.sdpMid !== null ? parsedCandidate.sdpMid : '',
            sdpMLineIndex: parsedCandidate.sdpMLineIndex !== undefined && parsedCandidate.sdpMLineIndex !== null ? parsedCandidate.sdpMLineIndex : 0
        };

        const canAddNow = isDescriptionSet && peerConnection && peerConnection.signalingState === 'stable';

        if (canAddNow) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(finalCandidate));
                console.log('ICE candidate added immediately:', finalCandidate);
            } catch (e) {
                console.error('Error adding ICE candidate immediately:', e, finalCandidate);
            }
        } else {
            iceCandidateBuffer.push(finalCandidate);
            console.log(`ICE candidate buffered (buffer length: ${iceCandidateBuffer.length}):`, finalCandidate);
        }
    });




}


// Socket.IO接続イベント
socket.on('connect', () => {
    console.log('Socket connected.');
    // PWAの役割をサーバーに通知
    socket.emit('register_role', 'staff');
    updateStatus('Unityクライアントを待機中...', 'loading');
});

// サーバーからWebRTC接続開始の指示を受け取るイベント
socket.on('start_webrtc', async () => {
    console.log('Received start_webrtc event from server. Initializing WebRTC.');
    // カメラが起動していなければ、デフォルトで前面カメラを起動
    if (!isRunning) {
        await startCamera('user');
    }
    initializeWebRTC();
});


// サーバーから切断通知を受け取った時の処理
socket.on('webrtc_close', () => {
    console.log('Received webrtc_close event. Stopping camera and closing peer connection.');
    stopCamera();
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannel = null;
    updateStatus('WebRTC接続が切断されました', 'error');
});

// エラーハンドリング
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