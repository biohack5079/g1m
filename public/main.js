import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';

// --- Debug Tool ---
const debugArea = document.getElementById('debug-log');
function log(msg, color = '#0f0') {
    const div = document.createElement('div');
    div.style.color = color;
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (debugArea) {
        debugArea.prepend(div);
        if (debugArea.children.length > 20) debugArea.lastChild.remove();
    }
    console.log(`[App] ${msg}`);
}
window.onerror = (m, u, l) => log(`ERROR: ${m} at line ${l}`, '#f55');

log('--- G1:M v1.0.2 START ---');

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
const cameraToggle = document.getElementById('camera-toggle');
const micBtn = document.getElementById('mic-btn');

// Global References from script tags
const io = window.io;
const Holistic = window.Holistic;
const drawConnectors = window.drawConnectors;
const POSE_CONNECTIONS = window.POSE_CONNECTIONS;

// Socket.IO
let socket;
try {
    socket = io();
    log('Signaling: Socket initiated');
} catch (e) { log('Signaling INIT Error: ' + e.message, '#f55'); }

// State
let peers = {};
let dataChannels = {};
let vrms = {};
let holistic = null;
let currentStream = null;
let isRunning = false;
let isSpeaking = false;
let isListening = false;
let mmdHelper = new MMDAnimationHelper();

// Bone Mapping
const BONE_MAP = {
    'センター': 'hips', '下半身': 'hips', '上半身': 'spine', '上半身2': 'chest',
    '首': 'neck', '頭': 'head', '左肩': 'leftShoulder', '左腕': 'leftUpperArm',
    '左ひじ': 'leftLowerArm', '左手首': 'leftHand', '右肩': 'rightShoulder',
    '右腕': 'rightUpperArm', '右ひじ': 'rightLowerArm', '右手首': 'rightHand',
    '左足': 'leftUpperLeg', '左ひざ': 'leftLowerLeg', '左足首': 'leftFoot',
    '右足': 'rightUpperLeg', '右ひざ': 'rightLowerLeg', '右足首': 'rightFoot'
};

// Three.js
let renderer, scene, camera, controls;
let clock = new THREE.Clock();

function updateStatus(message, type = 'loading') {
    if (statusText) statusText.textContent = message;
    if (statusDot) statusDot.className = `status-${type}`;
    log(`Status: ${message}`);
}

async function startApp() {
    log('App: startApp() execution begins');
    try {
        updateStatus('システム起動中...', 'loading');
        initThree();
        await initHolistic();
        updateStatus('G1:M 準備完了', 'ready');
    } catch (e) {
        log(`Fatal Error during startApp: ${e.message}`, '#f55');
        updateStatus('初期化エラー: ' + e.message, 'error');
    }
}

function initThree() {
    log('Three: Setting up renderer...');
    try {
        renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, alpha: true, antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.shadowMap.enabled = true;

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(35.0, window.innerWidth / window.innerHeight, 0.1, 1000.0);
        camera.position.set(0.0, 1.4, 4.0);

        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const light = new THREE.DirectionalLight(0xffffff, 1.5);
        light.position.set(1.0, 2.0, 1.0);
        scene.add(light);

        const grid = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
        scene.add(grid);

        // OrbitControls: カメラ操作（回転・拡大）の追加
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 1.3, 0);

        log('Three: Grid & Controls active, starting loop');
        animate();

        log('Three: Launching avatar load');
        loadAvatar('g1_mchan.glb', 'local', '自分');
    } catch (e) { log(`Three Loop Setup Error: ${e.message}`, '#f55'); }
}

async function loadAvatar(url, id, name) {
    log(`Loader: Fetching ${url} for ${id}...`);
    try {
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));

        const gltf = await new Promise((resolve, reject) => {
            loader.load(url, resolve, (xhr) => {
                const percent = xhr.total ? (xhr.loaded / xhr.total * 100).toFixed(0) : '?';
                updateStatus(`${name || id} (${percent}%) 読込中...`, 'loading');
            }, reject);
        });

        let vrm = gltf.userData.vrm;
        if (!vrm) {
            log(`Loader Warn: ${url} lacked VRM data, fallback to GLB mode`, '#ff0');
            vrm = { scene: gltf.scene, humanoid: { getRawBoneNode: () => null }, update: () => { } };
        }

        vrms[id] = vrm;
        vrm.name = name || id;
        scene.add(vrm.scene);
        vrm.scene.rotation.y = Math.PI;

        const label = document.createElement('div');
        label.id = `label-${id}`;
        label.className = 'avatar-label';
        label.textContent = vrm.name;
        if (labelsContainer) labelsContainer.appendChild(label);

        log(`Avatar ${vrm.name} added to scene`);
        updateParticipantCount();
    } catch (e) { log(`Loader Failure (${id}): ${e.message}`, '#f55'); }
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (mmdHelper) mmdHelper.update(delta);
    if (controls) controls.update(); // カメラ操作の更新

    Object.values(vrms).forEach(vrm => {
        if (vrm.update) vrm.update(delta);
        if (vrm.expressionManager && isSpeaking) {
            vrm.expressionManager.setValue('aa', (Math.sin(Date.now() / 100) + 1) * 0.4);
        }
    });

    Object.keys(vrms).forEach(id => {
        const vrm = vrms[id];
        const label = document.getElementById(`label-${id}`);
        if (label && camera) {
            const vector = new THREE.Vector3();
            vrm.scene.getWorldPosition(vector);
            vector.y += 1.8;
            vector.project(camera);
            label.style.left = `${(vector.x * 0.5 + 0.5) * window.innerWidth}px`;
            label.style.top = `${(-(vector.y * 0.5) + 0.5) * window.innerHeight}px`;
        }
    });

    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

async function initHolistic() {
    log('Holistic: Starting initiation...');
    if (typeof Holistic === 'undefined') { log('Holistic: MEDIA PIPE NOT LOADED!', '#f55'); return; }
    try {
        holistic = new Holistic({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}` });
        holistic.setOptions({ modelComplexity: 1, smoothLandmarks: true, refineFaceLandmarks: true, minDetectionConfidence: 0.5 });
        holistic.onResults(onHolisticResults);
        await holistic.initialize();
        log('Holistic: System Initialized');
    } catch (e) { log(`Holistic Error: ${e.message}`, '#f55'); }
}

function onHolisticResults(results) {
    if (canvasCtx) {
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        if (results.poseLandmarks && typeof drawConnectors !== 'undefined' && typeof POSE_CONNECTIONS !== 'undefined') {
            drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#00F2FF', lineWidth: 2 });
        }
        canvasCtx.restore();
    }
    if (vrms['local']) mapMotionToVRM(vrms['local'], results);
    syncMotion(results);
}

function mapMotionToVRM(vrm, res) {
    if (!vrm || !res) return;
    if (res.faceLandmarks && vrm.expressionManager) {
        const face = res.faceLandmarks;
        if (!isSpeaking) vrm.expressionManager.setValue('aa', Math.max(0, (face[14].y - face[13].y) * 10.0));
        vrm.expressionManager.setValue('blinkLeft', Math.abs(face[159].y - face[145].y) < 0.015 ? 1.0 : 0.0);
        vrm.expressionManager.setValue('blinkRight', Math.abs(face[386].y - face[374].y) < 0.015 ? 1.0 : 0.0);
        const head = vrm.humanoid.getRawBoneNode('head');
        if (head) { head.rotation.y = -(face[1].x - 0.5); head.rotation.x = (face[1].y - 0.5) * 0.5; }
    }
}

function syncMotion(results) {
    if (!results) return;
    const data = { type: 'motion', payload: { faceLandmarks: results.faceLandmarks, poseLandmarks: results.poseLandmarks } };
    Object.values(dataChannels).forEach(dc => { if (dc.readyState === 'open') dc.send(JSON.stringify(data)); });
}

function updateParticipantCount() {
    const activeCount = Object.keys(vrms).filter(id => id !== 'local' && id !== 'bot').length;
    if (participantCountText) participantCountText.textContent = `参加者: ${activeCount + 1}`;

    if (activeCount === 0 && !vrms['bot']) spawnBot();
    else if (activeCount > 0 && vrms['bot']) removeBot();

    updateLayout();
}

function updateLayout() {
    // Positioning Bot and Local
    if (vrms['bot']) {
        vrms['bot'].scene.position.set(0, 0, 1.2);
        vrms['bot'].scene.rotation.y = 0; // Face the center
    }
    if (vrms['local']) {
        vrms['local'].scene.position.set(0, 0, 0);
        vrms['local'].scene.rotation.y = Math.PI; // Face the bot
    }
    // Positioning Other Performers
    const performers = Object.keys(vrms).filter(id => id !== 'local' && id !== 'bot');
    performers.forEach((id, index) => {
        const vrm = vrms[id];
        vrm.scene.position.set((index + 1) * 1.5, 0, 0);
        vrm.scene.rotation.y = Math.PI;
    });
}

async function spawnBot() { await loadAvatar('g1_mchan.glb', 'bot', 'G1:Mちゃん (AI)'); }
function removeBot() { if (vrms['bot']) { scene.remove(vrms['bot'].scene); delete vrms['bot']; updateParticipantCount(); } }

if (socket) {
    socket.on('connect', () => { log('Socket: Server connection active'); socket.emit('register_role', 'viewer'); });
    socket.on('participants_list', (l) => l.filter(p => p.id !== socket.id).forEach(p => createPeer(p.id, true)));
    socket.on('participant_left', (d) => cleanupPeer(d.id));
    socket.on('offer', async (d) => {
        log(`WebRTC: Offer from ${d.from}`);
        const pc = await createPeer(d.from, false);
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
        socket.emit('answer', { targetId: d.from, sdp: ans });
    });
    socket.on('answer', async (d) => { log(`WebRTC: Answer from ${d.from}`); if (peers[d.from]) await peers[d.from].setRemoteDescription(new RTCSessionDescription(d.sdp)); });
    socket.on('candidate', async (d) => { log(`WebRTC: Candidate from ${d.from}`); if (peers[d.from]) await peers[d.from].addIceCandidate(new RTCIceCandidate(d.candidate)); });
}

function cleanupPeer(id) {
    if (peers[id]) peers[id].close();
    if (vrms[id]) { scene.remove(vrms[id].scene); const l = document.getElementById(`label-${id}`); if (l) l.remove(); delete vrms[id]; }
    delete peers[id]; delete dataChannels[id];
    updateParticipantCount();
}

async function createPeer(id, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peers[id] = pc;
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('candidate', { targetId: id, candidate: e.candidate }); };

    if (isInitiator) {
        const dc = pc.createDataChannel('motion');
        setupDC(id, dc);
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        socket.emit('offer', { targetId: id, sdp: offer });
    } else {
        pc.ondatachannel = (e) => setupDC(id, e.channel);
    }
    return pc;
}

function setupDC(id, dc) {
    dataChannels[id] = dc;
    dc.onopen = () => log(`DC Open: ${id.slice(0, 4)}`);
    dc.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'motion') {
                if (!vrms[id]) loadAvatar('g1_mchan.glb', id, `参加者 ${id.slice(0, 4)}`);
                else mapMotionToVRM(vrms[id], data.payload);
            }
            if (data.type === 'chat') speak(data.payload, `参加者 ${id.slice(0, 4)}`);
        } catch (err) { console.error('DC Message Error:', err); }
    };
    dc.onclose = () => cleanupPeer(id);
}

cameraToggle.onclick = async () => {
    if (isRunning) { isRunning = false; cameraToggle.classList.remove('active'); }
    else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            videoElement.srcObject = stream;
            isRunning = true; cameraToggle.classList.add('active');
            socket.emit('register_role', 'staff');
            const loop = async () => { if (isRunning) { try { await holistic.send({ image: videoElement }); } catch (e) { } requestAnimationFrame(loop); } };
            loop();
        } catch (e) { log('Camera Initiation Error: ' + e.message, '#f55'); }
    }
};

// --- Voice Recognition Restoration ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => { isListening = true; micBtn.classList.add('listening'); log('Speech: Listening...'); updateStatus('音声入力中...', 'running'); };
    recognition.onend = () => { isListening = false; micBtn.classList.remove('listening'); log('Speech: Stopped'); updateStatus('G1:M 準備完了', 'ready'); };
    recognition.onerror = (e) => { log(`Speech Error: ${e.error}`, '#f55'); isListening = false; micBtn.classList.remove('listening'); };

    recognition.onresult = (e) => {
        const text = e.results[0][0].transcript;
        if (chatInput) chatInput.value = text;
        log(`Speech Result: ${text}`);
        handleChat(text);
    };

    micBtn.onclick = () => {
        log('Mic clicked');
        if (isListening) { try { recognition.stop(); } catch (err) { } }
        else { try { recognition.start(); } catch (err) { log('Speech Start Error: ' + err.message, '#f55'); } }
    };
}

async function handleChat(text) {
    if (!text) return;
    const isAlone = Object.keys(vrms).filter(id => id !== 'local' && id !== 'bot').length === 0;
    if (isAlone) {
        log('Chat: AI (G1:M) processing...');
        const answer = await performLlmRequest(text);
        speak(answer, 'G1:M');
    } else {
        const data = { type: 'chat', payload: text };
        Object.values(dataChannels).forEach(dc => { if (dc.readyState === 'open') dc.send(JSON.stringify(data)); });
        speak(text, '自分');
    }
}

async function performLlmRequest(prompt) {
    let endpoint = 'https://cybernetcall-plower.hf.space/api/generate';
    try {
        const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cybernetcall-plower', prompt: prompt }) });
        if (res.ok) {
            const s = await res.json();
            return s.response || s.answer || "うまく答えられません。";
        }
    } catch (e) { log('LLM Error: ' + e.message, '#f55'); }
    return "接続エラー。";
}

async function speak(text, sender = '') {
    if (!subtitleArea) return;
    subtitleArea.style.opacity = 1; isSpeaking = true;
    let current = sender ? `[${sender}] ` : '';
    for (const char of text.split('')) {
        current += char; subtitleArea.textContent = current;
        await new Promise(r => setTimeout(r, 40));
    }
    await new Promise(r => setTimeout(r, 2000));
    subtitleArea.style.opacity = 0; isSpeaking = false;
}

startApp();
