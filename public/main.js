// 省略: videoElement, canvasElement, statusElement, UIボタン取得・MediaPipe初期化などはそのまま

// --- WebRTCの追加変数 ---
let iceCandidateBuffer = [];
let isDescriptionSet = false;

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
    
    // バッファとフラグは初期化時にクリア
    iceCandidateBuffer = [];
    isDescriptionSet = false;

    console.log('Initializing WebRTC.');

    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });

    // PWA側がDataChannelを作成する設定なので、自分は受け取る側としてdatachannelイベントを使うことも検討可
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

    // ICE candidateを収集したら逐次シグナリングサーバーに送信する
    peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
            console.log('Found and sending ICE candidate:', JSON.stringify(e.candidate));
            socket.emit('candidate', e.candidate);
        }
    };

    // negotiationneededイベントでOfferを作成、送信する。これでOffer生成処理が標準化されます。
    peerConnection.onnegotiationneeded = async () => {
        try {
            console.log('onnegotiationneeded triggered. Creating offer...');
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', peerConnection.localDescription);

            isDescriptionSet = true; // Offer送信時にフラグを立てる

            // Offer送信後にバッファしているICE候補を送信
            console.log(`Sending ${iceCandidateBuffer.length} buffered ICE candidates.`);
            for (const candidate of iceCandidateBuffer) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
            iceCandidateBuffer = []; // バッファクリア
        } catch (e) {
            console.error('Error in onnegotiationneeded:', e);
        }
    };

    // 接続状態変化をログ、失敗時は再初期化を試みる
    peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            console.warn('WebRTC connection failed. Re-initializing...');
            setTimeout(() => initializeWebRTC(), 3000);
        }
    };

    console.log('WebRTC initialized. Emitting staff_ready event.');
    socket.emit('staff_ready');
}

// Socket.IO接続イベント
socket.on('connect', () => {
    console.log('Socket connected.');
    initializeWebRTC();
});

// Offerを受け取った時の処理
socket.on('offer', async (offer) => {
    console.log('Received offer:', offer);

    if (peerConnection && peerConnection.signalingState !== 'closed') {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            isDescriptionSet = true;

            // バッファリングされているcandidateをセット
            console.log(`Adding ${iceCandidateBuffer.length} buffered ICE candidates after setting remote description.`);
            for (const candidate of iceCandidateBuffer) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
            iceCandidateBuffer = [];

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('answer', peerConnection.localDescription);
            console.log('Answer sent to Unity client');
        } catch (e) {
            console.error('Error handling received offer:', e);
        }
    }
});

// Answerを受け取った時の処理
socket.on('answer', async (answer) => {
    console.log('Received answer from Unity client:', answer);

    if (peerConnection && peerConnection.signalingState !== 'closed') {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            isDescriptionSet = true;

            // バッファ中のICE候補を追加
            console.log(`Adding ${iceCandidateBuffer.length} buffered ICE candidates after setting remote description.`);
            for (const candidate of iceCandidateBuffer) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
            iceCandidateBuffer = [];

            console.log('WebRTC answer received and set.');
        } catch (e) {
            console.error('Error setting remote description from answer:', e);
        }
    }
});

// ICE Candidateを受け取った時の処理、バッファリング対応済み
socket.on('candidate', async (candidate) => {
    console.log('Received ICE candidate from Unity client:', candidate);

    if (isDescriptionSet) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('ICE candidate added immediately.');
        } catch (e) {
            console.error('Error adding received ICE candidate immediately:', e);
        }
    } else {
        iceCandidateBuffer.push(candidate);
        console.log('ICE candidate buffered.');
    }
});

// ... エラーハンドリングや切断処理は必要に応じて追加 ...

