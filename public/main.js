import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRM, VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

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
const startFrontBtn = document.getElementById('startFrontCamera');
const startBackBtn = document.getElementById('startBackCamera');
const stopBtn = document.getElementById('stopCamera');
const micBtn = document.getElementById('mic-btn');
const vmdBtn = document.getElementById('vmd-load-btn');
const recordBtn = document.getElementById('record-btn');
const recordIcon = document.getElementById('record-icon');
const exportBtn = document.getElementById('export-btn');
const translateBtn = document.getElementById('translate-send-btn');

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
let lastResults = null;

// Recording State
let mediaRecorder;
let recordedChunks = [];
let isRecording = false;

// (Declarations moved to top)

// --- 3D Landmark Overlay (Visualizer) ---
let landmarkGroup = new THREE.Group();
let poseDots = [];
for (let i = 0; i < 33; i++) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.02), new THREE.MeshBasicMaterial({ color: 0x00f2ff }));
    dot.visible = false; landmarkGroup.add(dot); poseDots.push(dot);
}
let leftHandDots = [], rightHandDots = [];
for (let i = 0; i < 21; i++) {
    const ld = new THREE.Mesh(new THREE.SphereGeometry(0.015), new THREE.MeshBasicMaterial({ color: 0x00f2ff }));
    const rd = new THREE.Mesh(new THREE.SphereGeometry(0.015), new THREE.MeshBasicMaterial({ color: 0x7000ff }));
    ld.visible = rd.visible = false;
    landmarkGroup.add(ld); landmarkGroup.add(rd);
    leftHandDots.push(ld); rightHandDots.push(rd);
}
let faceDots = [];
for (let i = 0; i < 468; i += 10) { // Sampling face mesh for performance
    const fd = new THREE.Mesh(new THREE.SphereGeometry(0.005), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    fd.visible = false; landmarkGroup.add(fd); faceDots.push(fd);
}
let mmdHelper = new MMDAnimationHelper();

// Smoothing State
let smoothedResults = {
    poseLandmarks: null,
    leftHandLandmarks: null,
    rightHandLandmarks: null,
    faceLandmarks: null
};
const SMOOTHING_FACTOR = 0.3; // Lower = smoother, higher = more responsive

function lerpLandmarks(prev, curr, factor) {
    if (!prev) return curr;
    if (!curr) return prev;
    return curr.map((lm, i) => {
        const p = prev[i];
        if (!p) return lm;
        return {
            x: p.x + (lm.x - p.x) * factor,
            y: p.y + (lm.y - p.y) * factor,
            z: p.z + (lm.z - p.z) * factor,
            visibility: lm.visibility
        };
    });
}

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
let renderer, mainScene = new THREE.Scene(), camera, controls;
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

        log('Init: Starting Three.js...');
        initThree();
        log('Init: Three.js setup triggered');

        log('Init: Starting Holistic...');
        updateStatus('AIトラッキング初期化中...', 'loading');
        await initHolistic();
        log('Init: Holistic ready');

        updateStatus('G1:M 準備完了', 'ready');
        log('Init: All systems go!');
    } catch (e) {
        log(`Fatal Error during startApp: ${e.message}`, '#f55');
        console.error('Fatal Init Error:', e);
        updateStatus('初期化エラー: ' + e.message, 'error');
    }
}

function initThree() {
    log('Three: Setting up renderer...');
    try {
        renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, alpha: true, antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        // Disable shadowMap on mobile for performance and stability
        if (window.innerWidth > 768) renderer.shadowMap.enabled = true;

        // mainScene is already initialized
        // mainScene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(35.0, window.innerWidth / window.innerHeight, 0.1, 1000.0);
        camera.position.set(0.0, 1.4, 4.0);

        mainScene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const light = new THREE.DirectionalLight(0xffffff, 1.5);
        light.position.set(1.0, 2.0, 1.0);
        mainScene.add(light);

        const grid = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
        mainScene.add(grid);
        if (landmarkGroup) mainScene.add(landmarkGroup); // Add landmarks to scene

        // OrbitControls: カメラ操作（回転・拡大）の追加
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 1.3, 0);

        log('Three: Grid & Controls active, starting loop');

        // Initial Pose Setup: Arms down
        // We'll apply this in loadAvatar and animate loop until tracking takes over

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
        if (mainScene) {
            mainScene.add(vrm.scene);
            // Default VRM faces +Z. Camera is at +Z. 
            // Setting rotation to 0 to face the user (the camera).
            vrm.scene.rotation.y = 0;
        } else {
            log(`Loader Error: Scene not initialized when adding ${id}`, '#f55');
        }

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
    if (controls) controls.update();

    Object.values(vrms).forEach(vrm => {
        if (vrm.update) vrm.update(delta);

        // Apply tracking or initial pose
        if (vrm.name === '自分') {
            if (lastResults) {
                mapMotionToVRM(vrm, lastResults);
            } else {
                // Initial Pose: Arms down (Naturally)
                const leftUpper = vrm.humanoid?.getRawBoneNode('leftUpperArm');
                const rightUpper = vrm.humanoid?.getRawBoneNode('rightUpperArm');
                if (leftUpper) leftUpper.rotation.z = Math.PI * 0.45;
                if (rightUpper) rightUpper.rotation.z = -Math.PI * 0.45;
            }
        }

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

    if (renderer && mainScene && camera) {
        renderer.render(mainScene, camera);
    }
}

async function initHolistic() {
    log('Holistic: Starting initiation...');
    if (typeof Holistic === 'undefined') { log('Holistic: MEDIA PIPE NOT LOADED!', '#f55'); return; }
    try {
        holistic = new Holistic({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5/${file}`
        });
        holistic.setOptions({
            modelComplexity: 1,
            smoothLandmarks: true,
            refineFaceLandmarks: true,
            minDetectionConfidence: 0.5
        });
        holistic.onResults(onHolisticResults);

        log('Holistic: Running initialize()...');
        await holistic.initialize();
        log('Holistic: System Initialized');
    } catch (e) {
        log(`Holistic Error: ${e.message}`, '#f55');
        throw e;
    }
}

function updateLandmarks3D(res) {
    if (!vrms['local']) return;
    const vrm = vrms['local'];
    const pos = vrm.scene.position;
    const rot = vrm.scene.rotation.y;
    landmarkGroup.position.copy(pos);
    landmarkGroup.rotation.y = rot;

    // Bone mapping for anchors
    const bones = {
        head: vrm.humanoid?.getRawBoneNode('head'),
        lHand: vrm.humanoid?.getRawBoneNode('leftHand'),
        rHand: vrm.humanoid?.getRawBoneNode('rightHand'),
        hips: vrm.humanoid?.getRawBoneNode('hips')
    };

    const getPos = (bone) => {
        let v = new THREE.Vector3();
        if (bone) bone.getWorldPosition(v);
        return v;
    };

    const headPos = getPos(bones.head);
    const lHandPos = getPos(bones.lHand);
    const rHandPos = getPos(bones.rHand);
    const hipsPos = getPos(bones.hips);

    // --- Pose (Body) ---
    if (res.poseLandmarks) {
        res.poseLandmarks.forEach((lm, i) => {
            const p = poseDots[i];
            if (p) {
                // Map relative to hips for the body
                const offsetX = (lm.x - 0.5) * 1.5;
                const offsetY = (1.0 - lm.y) * 1.8;
                p.position.set(hipsPos.x + offsetX, offsetY, hipsPos.z);
                p.visible = true;
            }
        });
    }

    // --- Face ---
    if (res.faceLandmarks) {
        faceDots.forEach((d, index) => {
            const i = index * 10;
            const lm = res.faceLandmarks[i];
            if (lm && d) {
                // Map relative to head bone
                const offsetX = (lm.x - 0.5) * 0.25;
                const offsetY = (0.5 - lm.y) * 0.25;
                d.position.set(headPos.x + offsetX, headPos.y + offsetY, headPos.z + 0.1);
                d.visible = true;
            }
        });
    }

    // --- Hands ---
    if (res.leftHandLandmarks) {
        res.leftHandLandmarks.forEach((lm, i) => {
            const d = leftHandDots[i];
            if (d) {
                const offsetX = (lm.x - res.leftHandLandmarks[0].x) * 0.4;
                const offsetY = -(lm.y - res.leftHandLandmarks[0].y) * 0.4;
                d.position.set(lHandPos.x + offsetX, lHandPos.y + offsetY, lHandPos.z);
                d.visible = true;
            }
        });
    }
    if (res.rightHandLandmarks) {
        res.rightHandLandmarks.forEach((lm, i) => {
            const d = rightHandDots[i];
            if (d) {
                const offsetX = (lm.x - res.rightHandLandmarks[0].x) * 0.4;
                const offsetY = -(lm.y - res.rightHandLandmarks[0].y) * 0.4;
                d.position.set(rHandPos.x + offsetX, rHandPos.y + offsetY, rHandPos.z);
                d.visible = true;
            }
        });
    }
}

function onHolisticResults(results) {
    // Smoothing / Interpolation
    smoothedResults.poseLandmarks = lerpLandmarks(smoothedResults.poseLandmarks, results.poseLandmarks, SMOOTHING_FACTOR);
    smoothedResults.leftHandLandmarks = lerpLandmarks(smoothedResults.leftHandLandmarks, results.leftHandLandmarks, SMOOTHING_FACTOR);
    smoothedResults.rightHandLandmarks = lerpLandmarks(smoothedResults.rightHandLandmarks, results.rightHandLandmarks, SMOOTHING_FACTOR);
    smoothedResults.faceLandmarks = lerpLandmarks(smoothedResults.faceLandmarks, results.faceLandmarks, SMOOTHING_FACTOR);

    lastResults = smoothedResults; // Store smoothed results for the main loop
    if (smoothedResults) updateLandmarks3D(smoothedResults);

    if (canvasCtx) {
        if (canvasElement.width !== window.innerWidth) {
            canvasElement.width = window.innerWidth;
            canvasElement.height = window.innerHeight;
        }

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        // Drawing Connectors (Bones/Wireframe)
        // Accessing via window or global namespace if provided by MediaPipe
        const mpHolistic = window;
        const poseConn = mpHolistic.POSE_CONNECTIONS || window.POSE_CONNECTIONS;
        const handConn = mpHolistic.HAND_CONNECTIONS || window.HAND_CONNECTIONS;
        const faceConn = mpHolistic.FACEMESH_TESSELATION || window.FACEMESH_TESSELATION;

        if (typeof drawConnectors !== 'undefined') {
            // POSE
            if (smoothedResults.poseLandmarks && poseConn) {
                drawConnectors(canvasCtx, smoothedResults.poseLandmarks, poseConn, { color: '#00F2FF', lineWidth: 2 });
            }
            // HANDS
            if (smoothedResults.leftHandLandmarks && handConn) {
                drawConnectors(canvasCtx, smoothedResults.leftHandLandmarks, handConn, { color: '#00F2FF', lineWidth: 2 });
            }
            if (smoothedResults.rightHandLandmarks && handConn) {
                drawConnectors(canvasCtx, smoothedResults.rightHandLandmarks, handConn, { color: '#7000ff', lineWidth: 2 });
            }
        }
        canvasCtx.restore();
    }
    syncMotion(smoothedResults);
}

function mapMotionToVRM(vrm, res) {
    if (!vrm || !res || !vrm.humanoid) return;

    // Helper to get VR0/VR1 bones
    const getBone = (name) => {
        return vrm.humanoid.getRawBoneNode(name) || vrm.humanoid.getRawBoneNode(name.charAt(0).toUpperCase() + name.slice(1));
    };

    // --- Face (Head Rotation & Mouth) ---
    if (res.faceLandmarks && vrm.expressionManager) {
        const face = res.faceLandmarks;
        const mouthOpen = Math.max(0, (face[14].y - face[13].y) * 10.0);
        if (!isSpeaking) vrm.expressionManager.setValue('aa', mouthOpen);

        const head = getBone('head');
        if (head) {
            head.rotation.y = -(face[1].x - 0.5);
            head.rotation.x = (face[1].y - 0.5) * 0.5;
        }
    }

    // --- Pose (Shoulders & Arms) ---
    if (res.poseLandmarks) {
        const pose = res.poseLandmarks;
        const lUpper = getBone('leftUpperArm');
        const lLower = getBone('leftLowerArm');
        if (lUpper && pose[11] && pose[13]) {
            const angle = Math.atan2(pose[13].y - pose[11].y, pose[13].x - pose[11].x);
            lUpper.rotation.z = angle + Math.PI;
        }
        if (lLower && pose[13] && pose[15]) {
            const angle = Math.atan2(pose[15].y - pose[13].y, pose[15].x - pose[13].x);
            lLower.rotation.z = angle + Math.PI;
        }

        const rUpper = getBone('rightUpperArm');
        const rLower = getBone('rightLowerArm');
        if (rUpper && pose[12] && pose[14]) {
            const angle = Math.atan2(pose[14].y - pose[12].y, pose[14].x - pose[12].x);
            rUpper.rotation.z = angle;
        }
        if (rLower && pose[14] && pose[16]) {
            const angle = Math.atan2(pose[16].y - pose[14].y, pose[16].x - pose[14].x);
            rLower.rotation.z = angle;
        }
    }

    // --- Hands ---
    if (res.leftHandLandmarks) {
        const lHand = getBone('leftHand');
        if (lHand) lHand.rotation.y = Math.PI / 2;
    }
    if (res.rightHandLandmarks) {
        const rHand = getBone('rightHand');
        if (rHand) rHand.rotation.y = -Math.PI / 2;
    }
}

function syncMotion(results) {
    if (!results) return;
    const data = {
        type: 'motion',
        payload: {
            faceLandmarks: results.faceLandmarks,
            poseLandmarks: results.poseLandmarks,
            leftHandLandmarks: results.leftHandLandmarks,
            rightHandLandmarks: results.rightHandLandmarks
        }
    };
    Object.values(dataChannels).forEach(dc => { if (dc.readyState === 'open') dc.send(JSON.stringify(data)); });
}

function updateParticipantCount() {
    const othersCount = Object.keys(peers).length;
    if (participantCountText) participantCountText.textContent = `参加者: ${othersCount + 1}`;

    // AI Agent logic: only spawn bot if alone and it doesn't already exist
    if (othersCount === 0) {
        if (!vrms['bot']) spawnBot();
    } else {
        if (vrms['bot']) removeBot();
    }

    updateLayout();
}

function updateLayout() {
    if (vrms['local']) {
        vrms['local'].scene.position.set(0, 0, 0);
        vrms['local'].scene.rotation.y = 0; // Face the camera (+Z)
    }

    // Positioning Other Performers (including bot) in front of local (negative Z side)
    const others = Object.keys(vrms).filter(id => id !== 'local');
    const radius = 2.5;
    others.forEach((id, index) => {
        const vrm = vrms[id];
        // Distribute others across the negative Z hemisphere
        const angle = Math.PI + (index - (others.length - 1) / 2) * (Math.PI / 4);
        vrm.scene.position.set(
            Math.sin(angle) * radius,
            0,
            Math.cos(angle) * radius
        );
        // Make them face the center (local avatar)
        vrm.scene.lookAt(0, 0, 0);
    });
}

let isLoadingBot = false;
async function spawnBot() {
    if (isLoadingBot || vrms['bot']) return;
    isLoadingBot = true;

    if (vrms['local']) {
        log('Loader: Cloning local avatar for G1:M-chan bot');
        const botId = 'bot';
        const botName = 'G1:Mちゃん (AI)';

        // Clone the local scene instead of re-loading
        const clonedScene = THREE.SkeletonUtils.clone(vrms['local'].scene);

        // Create a basic VRM-like object (simplified since we only need scene and basic updates)
        const botVrm = {
            scene: clonedScene,
            name: botName,
            humanoid: vrms['local'].humanoid, // Re-use humanoid for bone refs if possible or just rely on bone names
            update: (delta) => { /* bot specific logic */ }
        };

        vrms[botId] = botVrm;
        if (mainScene) mainScene.add(clonedScene);
        else log('Loader Error: mainScene missing during bot spawn', '#f55');

        const label = document.createElement('div');
        label.id = `label-${botId}`;
        label.className = 'avatar-label';
        label.textContent = botName;
        if (labelsContainer) labelsContainer.appendChild(label);

        updateParticipantCount();
    } else {
        await loadAvatar('g1_mchan.glb', 'bot', 'G1:Mちゃん (AI)');
    }
    isLoadingBot = false;
}

function removeBot() {
    if (vrms['bot']) {
        if (mainScene) mainScene.remove(vrms['bot'].scene);
        const label = document.getElementById('label-bot');
        if (label) label.remove();
        delete vrms['bot'];
        updateParticipantCount();
    }
}

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
    if (vrms[id]) {
        if (mainScene) mainScene.remove(vrms[id].scene);
        const l = document.getElementById(`label-${id}`); if (l) l.remove(); delete vrms[id];
    }
    delete peers[id]; delete dataChannels[id];
    updateParticipantCount();
}

async function createPeer(id, isInitiator) {
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    });
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


async function startCamera(mode = 'user') {
    log(`Camera: Requesting ${mode}...`);
    try {
        // Robust Constraints for Mobile/PC
        const constraints = {
            video: {
                facingMode: { ideal: mode },
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 30 }
            }
        };

        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
        }

        let stream;
        try {
            log(`Camera: Attempting getUserMedia with ideal constraints...`);
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            log(`Camera: Ideal constraints failed: ${err.name}. Retrying with basic...`, '#ff0');
            stream = await navigator.mediaDevices.getUserMedia({ video: true });
        }

        currentStream = stream;
        videoElement.srcObject = stream;

        // Ensure video is playing for iOS Safari
        return new Promise((resolve, reject) => {
            videoElement.onloadedmetadata = async () => {
                try {
                    await videoElement.play();
                    log('Camera: Video stream playing');

                    videoElement.width = videoElement.videoWidth;
                    videoElement.height = videoElement.videoHeight;
                    log(`Camera: Dimensions ${videoElement.width}x${videoElement.height}`);

                    isRunning = true;
                    const loop = async () => {
                        if (isRunning) {
                            try {
                                if (videoElement.readyState >= 2) {
                                    await holistic.send({ image: videoElement });
                                }
                            } catch (e) {
                                // Silent fail for single frame send errors
                            }
                            requestAnimationFrame(loop);
                        }
                    };
                    loop();
                    log('Tracking: Loop started');
                    resolve();
                } catch (playErr) {
                    log(`Camera: Play promise rejected: ${playErr.message}`, '#f55');
                    reject(playErr);
                }
            };
            videoElement.onerror = (e) => reject(new Error('Video element error'));
        });

    } catch (e) {
        log('Camera Fatal Error: ' + e.message, '#f55');
        alert('カメラの起動に失敗しました。ブラウザの設定と権限を確認してください。');
        throw e;
    }
}

if (startFrontBtn) startFrontBtn.onclick = () => { socket.emit('register_role', 'staff'); startCamera('user'); };
if (startBackBtn) startBackBtn.onclick = () => { socket.emit('register_role', 'staff'); startCamera('environment'); };
if (stopBtn) stopBtn.onclick = () => location.reload();

// --- Motion (VMD) Loading Logic ---
const vmdInput = document.getElementById('vmd-file-input');

if (vmdBtn && vmdInput) {
    vmdBtn.onclick = () => vmdInput.click();
    vmdInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file || !vrms['local']) return;

        log(`MMD: Loading motion ${file.name}...`);
        try {
            const loader = new MMDLoader();
            const url = URL.createObjectURL(file);

            loader.loadAnimation(url, vrms['local'].scene, (mmd) => {
                log('MMD: Motion loaded, playing...');
                mmdHelper.add(vrms['local'].scene, { animation: mmd });
                // Note: Tracking might conflict, so we might need a toggle
            }, (xhr) => {
                log(`MMD: ${(xhr.loaded / xhr.total * 100).toFixed(0)}%`);
            }, (err) => {
                log('MMD Error: ' + err.message, '#f55');
            });
        } catch (err) { log('MMD Loader Error: ' + err.message, '#f55'); }
    };
}

// --- Voice Recognition Restoration ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => { isListening = true; micBtn.classList.add('listening'); log('Speech: Listening...'); updateStatus('音声入力中...', 'running'); };
    recognition.onend = () => { isListening = false; micBtn.classList.remove('listening'); log('Speech: Stopped'); updateStatus('G1:M 準備完了', 'ready'); };
    recognition.onerror = (e) => {
        log(`Speech Error DETAILED: ${e.error} ${e.message || ''}`, '#f55');
        isListening = false; micBtn.classList.remove('listening');
    };

    recognition.onresult = (e) => {
        const text = e.results[0][0].transcript;
        if (chatInput) chatInput.value = text;
        log(`Speech Result: ${text}`);
        handleChat(text);
    };

    if (micBtn) {
        micBtn.onclick = () => {
            log('Mic clicked');
            if (isListening) { try { recognition.stop(); } catch (err) { } }
            else { try { recognition.start(); } catch (err) { log('Speech Start Error: ' + err.message, '#f55'); } }
        };
    }
}

// --- i18n Support ---
const labels = {
    ja: {
        logo: "G1:m Dance Floor",
        chatPlaceholder: "G1:mちゃんに話しかける...",
        micLabel: "マイク",
        cameraLabel: "カメラ",
        frontLabel: "前面",
        backLabel: "背面",
        stopLabel: "終了",
        motionLabel: "モーション",
        participants: "参加者: "
    },
    en: {
        logo: "G1:m Dance Floor",
        chatPlaceholder: "Talk to G1:m-chan...",
        micLabel: "Mic",
        cameraLabel: "Camera",
        frontLabel: "Front",
        backLabel: "Back",
        stopLabel: "Stop",
        motionLabel: "Motion",
        participants: "Participants: "
    }
};

function applyI18n() {
    const lang = navigator.language.startsWith('ja') ? 'ja' : 'en';
    const t = labels[lang];

    if (chatInput) chatInput.placeholder = t.chatPlaceholder;
    const logoEl = document.getElementById('main-logo');
    if (logoEl) logoEl.textContent = t.logo;

    // Update button labels
    const btnLabels = document.querySelectorAll('.btn-label');
    btnLabels.forEach(el => {
        if (el.textContent === 'カメラ') el.textContent = t.cameraLabel;
        if (el.textContent === 'マイク') el.textContent = t.micLabel;
        if (el.textContent === '前面') el.textContent = t.frontLabel;
        if (el.textContent === '背面') el.textContent = t.backLabel;
        if (el.textContent === '終了') el.textContent = t.stopLabel;
        if (el.textContent === 'モーション') el.textContent = t.motionLabel;
    });
}

applyI18n();

async function speak(text, sender = '') {
    if (!subtitleArea) return;

    subtitleArea.style.opacity = 1;
    subtitleArea.style.transform = 'translate(-50%, -50%) scale(1)';
    isSpeaking = true;

    let current = sender ? `[${sender}] ` : '';
    // If text is too long, we might want to truncate or wrap (CSS handles wrap)

    subtitleArea.textContent = current;

    // Typewriter effect
    for (const char of text.split('')) {
        current += char;
        subtitleArea.textContent = current;
        await new Promise(r => setTimeout(r, 30));
    }

    // Keep visible for at least 3 seconds
    await new Promise(r => setTimeout(r, 3000));

    subtitleArea.style.opacity = 0;
    subtitleArea.style.transform = 'translate(-50%, -50%) scale(0.95)';
    isSpeaking = false;
}

// Update handleChat to use speak for own messages too
async function handleChat(text, option = {}) {
    if (!text) return;
    log(`Chat: ${text}`);

    const isAlone = Object.keys(vrms).filter(id => id !== 'local' && id !== 'bot').length === 0;

    // Translation logic
    let sendText = text;
    if (option.translate) {
        log('Chat: Translating to English...');
        const translationPrompt = `Translate the following Japanese text to English. Return ONLY the translation.\n\nText: ${text}`;
        sendText = await performLlmRequest(translationPrompt);
        log(`Chat: Translated to: ${sendText}`);
    }

    // Show locally immediately
    speak(sendText, '自分');

    if (isAlone) {
        log('Chat: AI (G1:M) processing...');
        const answer = await performLlmRequest(sendText);
        speak(answer, 'G1:M');
    } else {
        // Participants are present: Exclusive mode
        // Instead of free-form, we could show "Help" options if requested
        if (text.toLowerCase() === 'help') {
            const helpMsg = "HELP MENU:\n1. Dance Mode\n2. Group Intro\n3. System Info";
            speak(helpMsg, 'G1:M (System)');
        }

        const data = { type: 'chat', payload: sendText };
        Object.values(dataChannels).forEach(dc => { if (dc.readyState === 'open') dc.send(JSON.stringify(data)); });
    }

    if (chatInput) chatInput.value = '';
}

// --- Recording Logic ---
if (recordBtn) {
    recordBtn.onclick = () => {
        if (!isRecording) {
            startRecording();
        } else {
            stopRecording();
        }
    };
}

function startRecording() {
    recordedChunks = [];
    const stream = threeCanvas.captureStream(30); // Capture Three.js canvas at 30fps
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
        log('Recording: Stopped');
    };

    mediaRecorder.start();
    isRecording = true;
    recordIcon.textContent = '🔴';
    recordBtn.style.background = 'rgba(255, 0, 0, 0.4)';
    log('Recording: Started');
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        recordIcon.textContent = '⚪️';
        recordBtn.style.background = 'var(--glass)';
    }
}

if (exportBtn) {
    exportBtn.onclick = () => {
        if (recordedChunks.length === 0) {
            alert('録画データがありません。');
            return;
        }
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `G1M_Session_${Date.now()}.webm`;
        a.click();
        log('Export: Download started');
    };
}

if (translateBtn) {
    translateBtn.onclick = () => handleChat(chatInput.value, { translate: true });
}

sendBtn.onclick = () => handleChat(chatInput.value);
chatInput.onkeydown = (e) => { if (e.key === 'Enter') handleChat(chatInput.value); };

async function performLlmRequest(prompt) {
    // Updating to GPT 20B endpoint on Hugging Face as per user request
    // The user mentioned checking plower/script.js for model info.
    // GPT 20B is often a larger model, so we'll use a direct API if possible or the established Space.
    let endpoint = 'https://cybernetcall-plower.hf.space/api/generate';
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-20b', // Specific model name for the Space
                prompt: prompt
            })
        });
        if (res.ok) {
            const s = await res.json();
            return s.response || s.answer || s.result || "うまく答えられません。";
        }
    } catch (e) { log('LLM Error: ' + e.message, '#f55'); }
    return "接続エラー。";
}

startApp();
