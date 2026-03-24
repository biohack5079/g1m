import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';

// HTML elements
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const threeCanvas = document.getElementById('three-canvas');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status');
const participantCountText = document.getElementById('participant-count');
const subtitleArea = document.getElementById('subtitle-area');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('chat-send-btn');
const labelsContainer = document.getElementById('labels-container');

// Control buttons
const cameraToggle = document.getElementById('camera-toggle');
const micBtn = document.getElementById('mic-btn');
const startFrontBtn = document.getElementById('startFrontCamera');
const startBackBtn = document.getElementById('startBackCamera');
const stopBtn = document.getElementById('stopCamera');
const vmdLoadBtn = document.getElementById('vmd-load-btn');
const vmdFileInput = document.getElementById('vmd-file-input');

// Socket.IO
const socket = io();

// State
let peers = {};
let dataChannels = {};
let vrms = {};
let holistic = null;
let currentStream = null;
let isHolisticReady = false;
let isRunning = false;
let isSpeaking = false;
let isListening = false;
let currentViewIndex = 0;
let mmdHelper = new MMDAnimationHelper();
let myRole = 'viewer';

const BONE_MAP = {
    'センター': 'hips', '下半身': 'hips', '上半身': 'spine', '上半身2': 'chest',
    '首': 'neck', '頭': 'head', '左肩': 'leftShoulder', '左腕': 'leftUpperArm',
    '左ひじ': 'leftLowerArm', '左手首': 'leftHand', '右肩': 'rightShoulder',
    '右腕': 'rightUpperArm', '右ひじ': 'rightLowerArm', '右手首': 'rightHand',
    '左足': 'leftUpperLeg', '左ひざ': 'leftLowerLeg', '左足首': 'leftFoot',
    '右足': 'rightUpperLeg', '右ひざ': 'rightLowerLeg', '右足首': 'rightFoot'
};

const MORPH_MAP = {
    'あ': 'aa', 'い': 'ih', 'う': 'ou', 'え': 'ee', 'お': 'oh',
    'まばたき': 'blink', '笑い': 'relaxed', 'じと目': 'neutral'
};

// LLM Settings
let llmEndpoint = 'https://cybernetcall-plower.hf.space/api/generate';

// Three.js
let renderer, scene, camera;
let clock = new THREE.Clock();

function updateStatus(message, type = 'loading') {
    statusText.textContent = message;
    statusDot.className = `status-${type}`;
    console.log(`[Status] ${message}`);
}

async function startApp() {
    try {
        updateStatus('システム起動中...', 'loading');
        initThree();
        await initHolistic();
        updateStatus('G1:M 準備完了', 'ready');
    } catch (e) {
        console.error('Fatal initialization error:', e);
        updateStatus('初期化エラー: ' + e.message, 'error');
    }
}

function initThree() {
    renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35.0, window.innerWidth / window.innerHeight, 0.1, 1000.0);
    camera.position.set(0.0, 1.4, 4.0);

    const light = new THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(1.0, 2.0, 1.0);
    light.castShadow = true;
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    const grid = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
    scene.add(grid);

    loadAvatar('g1_mchan.glb', 'local', '自分');
    animate();
}

async function loadAvatar(url, id, name) {
    try {
        updateStatus(`${name || id} 加込開始...`, 'loading');
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));

        const gltf = await new Promise((resolve, reject) => {
            loader.load(url, resolve, (xhr) => {
                const percent = (xhr.loaded / xhr.total * 100).toFixed(0);
                updateStatus(`${name || id} (${percent}%) 読込中...`, 'loading');
            }, reject);
        });

        let vrmInstance = gltf.userData.vrm;
        if (!vrmInstance) {
            console.warn('VRM not found, loading as GLB');
            vrmInstance = { scene: gltf.scene, humanoid: { getRawBoneNode: () => null }, update: () => { } };
        } else {
            // VRMUtils.removeUnusedVerticesAndObject3D(gltf.scene);
        }

        vrms[id] = vrmInstance;
        vrmInstance.name = name || id;
        scene.add(vrmInstance.scene);
        vrmInstance.scene.rotation.y = Math.PI;

        const label = document.createElement('div');
        label.id = `label-${id}`;
        label.className = 'avatar-label';
        label.textContent = vrmInstance.name;
        labelsContainer.appendChild(label);

        updateStatus(`${vrmInstance.name} 表示完了`, 'running');
        updateParticipantCount();
        return vrmInstance;
    } catch (e) {
        console.error(e);
        updateStatus('読込失敗: ' + id, 'error');
    }
}

function updateParticipantCount() {
    const allPeersCount = Object.keys(peers).length;
    const performerPeers = Object.keys(vrms).filter(id => id !== 'local' && id !== 'bot');
    const performerCount = performerPeers.length;
    participantCountText.textContent = `参加者: ${allPeersCount + 1}${performerCount > 0 ? ` (配信中: ${performerCount})` : ''}`;

    if (performerCount === 0 && !vrms['bot']) spawnBot();
    else if (performerCount > 0 && vrms['bot']) removeBot();
    updateLayout();
}

function updateLayout() {
    const ids = Object.keys(vrms);
    const isMobile = window.innerWidth <= 768;
    ids.forEach((id, index) => {
        const vrm = vrms[id];
        if (isMobile) vrm.scene.position.x = index * 5.0;
        else vrm.scene.position.x = (index - (ids.length - 1) / 2) * 1.5;
    });
    if (isMobile) focusAvatar(currentViewIndex);
}

function focusAvatar(index) {
    currentViewIndex = index;
    if (window.innerWidth <= 768) {
        camera.position.x = index * 5.0;
        camera.position.z = 3.5;
    }
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    mmdHelper.update(delta);
    Object.values(vrms).forEach(vrm => {
        if (vrm.update) vrm.update(delta);
        if (vrm.expressionManager && isSpeaking) {
            vrm.expressionManager.setValue('aa', (Math.sin(Date.now() / 100) + 1) * 0.4);
        }
    });

    Object.keys(vrms).forEach(id => {
        const vrm = vrms[id];
        const label = document.getElementById(`label-${id}`);
        if (label) {
            const vector = new THREE.Vector3();
            vrm.scene.getWorldPosition(vector);
            vector.y += 1.8;
            vector.project(camera);
            label.style.left = `${(vector.x * 0.5 + 0.5) * window.innerWidth}px`;
            label.style.top = `${(-(vector.y * 0.5) + 0.5) * window.innerHeight}px`;
        }
    });
    renderer.render(scene, camera);
}

// --- Holistic (MediaPipe) ---
async function initHolistic() {
    updateStatus('MediaPipe 読込中...', 'loading');
    holistic = new Holistic({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}` });
    holistic.setOptions({ modelComplexity: 1, smoothLandmarks: true, refineFaceLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    holistic.onResults(onHolisticResults);
    await holistic.initialize();
    isHolisticReady = true;
}

function onHolisticResults(results) {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    if (results.poseLandmarks) drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#00F2FF', lineWidth: 2 });
    canvasCtx.restore();
    if (vrms['local']) mapMotionToVRM(vrms['local'], results);
    syncMotion(results);
}

function mapMotionToVRM(vrm, res) {
    if (!vrm || !res || !res.faceLandmarks) return;
    const face = res.faceLandmarks;
    if (vrm.expressionManager && !isSpeaking) {
        vrm.expressionManager.setValue('aa', Math.max(0, (face[14].y - face[13].y) * 10.0));
        vrm.expressionManager.setValue('blinkLeft', Math.abs(face[159].y - face[145].y) < 0.015 ? 1.0 : 0.0);
        vrm.expressionManager.setValue('blinkRight', Math.abs(face[386].y - face[374].y) < 0.015 ? 1.0 : 0.0);
    }
}

function syncMotion(results) {
    const data = { type: 'motion', payload: results };
    const str = JSON.stringify(data);
    Object.values(dataChannels).forEach(dc => { if (dc.readyState === 'open') dc.send(str); });
}

// --- LLM ---
async function handleChat(text) {
    if (!text) return;
    const isAlone = Object.keys(vrms).filter(id => id !== 'local' && id !== 'bot').length === 0;
    if (isAlone) {
        const answer = await performLlmRequest(text);
        speak(answer, 'G1:M');
    } else {
        const data = { type: 'chat', payload: text };
        Object.values(dataChannels).forEach(dc => { if (dc.readyState === 'open') dc.send(JSON.stringify(data)); });
        speak(text, '自分');
    }
}

async function performLlmRequest(prompt) {
    updateStatus('G1:M 思考中...', 'loading');
    try {
        const res = await fetch(llmEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cybernetcall-plower', prompt: prompt }) });
        if (res.ok) {
            const json = await res.json();
            updateStatus('G1:M ONLINE', 'running');
            return json.response || json.answer || "うまく答えられませんでした。";
        }
    } catch (e) { console.error(e); }
    return "接続エラーが発生しました。";
}

async function speak(text, sender = '') {
    subtitleArea.textContent = '';
    subtitleArea.style.opacity = 1;
    isSpeaking = true;
    let current = sender ? `[${sender}] ` : '';
    for (const char of text.split('')) {
        current += char;
        subtitleArea.textContent = current;
        await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 2000));
    subtitleArea.style.opacity = 0;
    isSpeaking = false;
}

// --- WebRTC ---
async function createPeer(id, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peers[id] = pc;
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('candidate', { targetId: id, candidate: e.candidate }); };
    if (isInitiator) {
        const dc = pc.createDataChannel('motion'); setupDC(id, dc);
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        socket.emit('offer', { targetId: id, sdp: offer });
    } else { pc.ondatachannel = (e) => setupDC(id, e.channel); }
    return pc;
}

function setupDC(id, dc) {
    dataChannels[id] = dc;
    dc.onopen = () => updateStatus(`接続確立: ${id.slice(0, 4)}`, 'running');
    dc.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.type === 'motion') {
            if (!vrms[id]) loadAvatar('g1_mchan.glb', id, `参加者 ${id.slice(0, 4)}`);
            else mapMotionToVRM(vrms[id], d.payload);
        }
        if (d.type === 'chat') speak(d.payload, `参加者 ${id.slice(0, 4)}`);
    };
    dc.onclose = () => cleanupPeer(id);
}

function cleanupPeer(id) {
    if (peers[id]) peers[id].close();
    if (vrms[id]) { scene.remove(vrms[id].scene); const l = document.getElementById(`label-${id}`); if (l) l.remove(); delete vrms[id]; }
    delete peers[id]; delete dataChannels[id];
    updateParticipantCount();
}

async function spawnBot() { await loadAvatar('g1_mchan.glb', 'bot', 'G1:Mちゃん (AI)'); }
function removeBot() { if (vrms['bot']) { scene.remove(vrms['bot'].scene); const l = document.getElementById('label-bot'); if (l) l.remove(); delete vrms['bot']; updateParticipantCount(); } }

function updatePlaceholder() {
    const isAlone = Object.keys(vrms).filter(id => id !== 'local' && id !== 'bot').length === 0;
    chatInput.placeholder = isAlone ? "G1:Mちゃんに話しかける..." : "参加者にメッセージを送る...";
}

// --- Signaling ---
socket.on('connect', () => socket.emit('register_role', 'viewer'));
socket.on('participants_list', (l) => l.filter(p => p.id !== socket.id).forEach(p => createPeer(p.id, true)));
socket.on('participant_left', (d) => cleanupPeer(d.id));
socket.on('offer', async (d) => {
    const pc = await createPeer(d.from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    socket.emit('answer', { targetId: d.from, sdp: ans });
});
socket.on('answer', async (d) => { if (peers[d.from]) await peers[d.from].setRemoteDescription(new RTCSessionDescription(d.sdp)); });
socket.on('candidate', async (d) => { if (peers[d.from]) await peers[d.from].addIceCandidate(new RTCIceCandidate(d.candidate)); });

// --- Controls ---
cameraToggle.onclick = async () => {
    if (isRunning) { isRunning = false; cameraToggle.classList.remove('active'); }
    else {
        await startCamera('user');
        cameraToggle.classList.add('active');
        if (myRole !== 'performer') { myRole = 'performer'; socket.emit('register_role', 'staff'); updatePlaceholder(); }
    }
};

async function startCamera(mode) {
    try {
        if (currentStream) currentStream.getTracks().forEach(t => t.stop());
        currentStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode } });
        videoElement.srcObject = currentStream;
        isRunning = true;
        const loop = async () => { if (isRunning) { await holistic.send({ image: videoElement }); requestAnimationFrame(loop); } };
        loop();
    } catch (e) { console.error(e); }
}

startFrontBtn.onclick = () => startCamera('user');
startBackBtn.onclick = () => startCamera('environment');
stopBtn.onclick = () => location.reload();
sendBtn.onclick = () => { handleChat(chatInput.value); chatInput.value = ''; };
chatInput.onkeydown = (e) => { if (e.key === 'Enter') { handleChat(chatInput.value); chatInput.value = ''; } };

vmdLoadBtn.onclick = () => vmdFileInput.click();
vmdFileInput.onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const loader = new MMDLoader();
    const buffer = await file.arrayBuffer();
    const vmd = loader.parseVmd(buffer);
    applyVmdToVrm(vmd);
};

function applyVmdToVrm(vmd) {
    Object.values(vrms).forEach(vrm => {
        const clip = mmdHelper.vmdToAnimationClip(vmd);
        clip.tracks.forEach(track => {
            const parts = track.name.split('.');
            const vrmBoneName = BONE_MAP[parts[0]];
            if (vrmBoneName) {
                const boneNode = vrm.humanoid.getRawBoneNode(vrmBoneName);
                if (boneNode) track.name = `${boneNode.name}.${parts[1]}`;
            }
        });
        const mixer = new THREE.AnimationMixer(vrm.scene);
        mixer.clipAction(clip).play();
        mmdHelper.add(vrm.scene, { mixer: mixer });
    });
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.onresult = (e) => { chatInput.value = e.results[0][0].transcript; handleChat(chatInput.value); };
    micBtn.onclick = () => { if (isListening) { recognition.stop(); isListening = false; micBtn.classList.remove('listening'); } else { recognition.start(); isListening = true; micBtn.classList.add('listening'); } };
}

window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); updateLayout(); });

startApp();
