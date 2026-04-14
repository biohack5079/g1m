import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin } from '@pixiv/three-vrm';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { io, Socket } from 'socket.io-client';
import './App.css';

interface Participant {
  id: string;
  role: string;
}

// MediaPipeのグローバル型定義
declare global {
  interface Window {
    Holistic: any;
    Camera: any;
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

const SMOOTH_FACTOR = 0.3; // 0.1(滑らか) 〜 1.0(高速)

// 座標補間ヘルパー
const lerpLandmarks = (prev: any, curr: any) => {
  if (!prev) return curr;
  if (!curr) return prev;
  return curr.map((lm: any, i: number) => {
    const p = prev[i];
    if (!p) return lm;
    return {
      x: p.x + (lm.x - p.x) * SMOOTH_FACTOR,
      y: p.y + (lm.y - p.y) * SMOOTH_FACTOR,
      z: p.z + (lm.z - p.z) * SMOOTH_FACTOR,
      visibility: lm.visibility
    };
  });
};

const App: React.FC = () => {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [subtitle, setSubtitle] = useState("");
  const [isMicActive, setIsMicActive] = useState(false);
  const [status, setStatus] = useState("システム起動中...");
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null);
  const [chatInput, setChatInput] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const vrmsRef = useRef<{ [key: string]: VRM }>({});
  const loadingVrmsRef = useRef<Set<string>>(new Set()); // 読み込み中IDのガード
  const recognitionRef = useRef<any>(null);
  const peersRef = useRef<{ [key: string]: RTCPeerConnection }>({});
  const dataChannelsRef = useRef<{ [key: string]: RTCDataChannel }>({});
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const holisticRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const lastResultsRef = useRef<any>(null);
  const smoothedResultsRef = useRef<any>({
    poseLandmarks: null,
    leftHandLandmarks: null,
    rightHandLandmarks: null,
    faceLandmarks: null
  });
  const landmarkGroupRef = useRef<THREE.Group>(new THREE.Group());
  const poseDotsRef = useRef<THREE.Mesh[]>([]);
  const poseLinesRef = useRef<THREE.Line[]>([]);
  const handDotsRef = useRef<{left: THREE.Mesh[], right: THREE.Mesh[]}>({ left: [], right: [] });
  const handLinesRef = useRef<{left: THREE.Line[], right: THREE.Line[]}>({ left: [], right: [] });

  // 最新の参加者リストをRefで保持（Socket通信のクロージャ対策）
  const participantsRef = useRef<Participant[]>([]);
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // メモリ解放
  const disposeVRM = (vrm: VRM) => {
    if (!vrm) return;
    try {
      vrm.scene.traverse((obj: any) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((m: any) => {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        }
      });
      if (sceneRef.current) sceneRef.current.remove(vrm.scene);
    } catch (e) {
      console.error("Dispose error:", e);
    }
  };

  // アバターの配置更新 (TikTok/GridスタイルUIの基盤)
  const updateLayout = useCallback(() => {
    const ids = Object.keys(vrmsRef.current);
    const radius = 2.5;
    ids.forEach((id, index) => {
      const vrm = vrmsRef.current[id];
      if (id === 'local') {
        vrm.scene.position.set(0, 0, 0);
        vrm.scene.rotation.y = 0;
      } else {
        const angle = Math.PI + (index - (ids.length - 2) / 2) * (Math.PI / 4);
        vrm.scene.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
        vrm.scene.lookAt(0, 0, 0);
      }
    });
  }, []);

  // AI Agent (Bot) スポーン
  const spawnBot = useCallback(async () => {
    if (vrmsRef.current['bot'] || !vrmsRef.current['local']) return;
    setStatus("G1:Mちゃん (AI) 接続中...");
    
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync('/g1-m_chan.glb');
    const vrm = gltf.userData.vrm as VRM;
    
    vrmsRef.current['bot'] = vrm;
    sceneRef.current?.add(vrm.scene);
    updateLayout();
    setStatus("G1:M 準備完了 (AIモード)");
  }, [updateLayout]);

  const removeBot = useCallback(() => {
    if (vrmsRef.current['bot']) {
      disposeVRM(vrmsRef.current['bot']);
      delete vrmsRef.current['bot'];
      updateLayout();
    }
  }, [updateLayout]);

  // モーション適用
  const mapMotionToVRM = (vrm: VRM, res: any) => {
    if (!vrm || !res || !vrm.humanoid) return;
    
    // ボーン取得ヘルパー (正規化されたボーンを取得)
    const getBone = (name: string) => {
      return vrm.humanoid.getNormalizedBoneNode(name as any);
    };

    // ポーズ適用
    if (res.poseLandmarks) {
      const pose = res.poseLandmarks;
      const lUpper = getBone('leftUpperArm');
      const lLower = getBone('leftLowerArm');
      const rUpper = getBone('rightUpperArm');
      const rLower = getBone('rightLowerArm');

      // デバッグログ (初回のみ or 定期的に)
      if (Math.random() < 0.01) {
        console.log("Pose tracking active. Bones found:", { lUpper: !!lUpper, rUpper: !!rUpper });
      }

      if (lUpper && pose[11] && pose[13]) {
        // 斜め下のデフォルト角度を考慮しつつ計算
        const dx = pose[13].x - pose[11].x;
        const dy = pose[13].y - pose[11].y;
        const angle = Math.atan2(dy, dx);
        // 左腕のマッピング修正
        lUpper.rotation.z = angle; 
      }
      if (lLower && pose[13] && pose[15]) {
        const angle = Math.atan2(pose[15].y - pose[13].y, pose[15].x - pose[13].x);
        lLower.rotation.z = angle;
      }

      if (rUpper && pose[12] && pose[14]) {
        const dx = pose[14].x - pose[12].x;
        const dy = pose[14].y - pose[12].y;
        const angle = Math.atan2(dy, dx);
        // 右腕のマッピング修正
        rUpper.rotation.z = -angle + Math.PI;
      }
      if (rLower && pose[14] && pose[16]) {
        const angle = Math.atan2(pose[16].y - pose[14].y, pose[16].x - pose[14].x);
        rLower.rotation.z = -angle + Math.PI;
      }
    }

    // --- Hands (Fingers) ---
    const mapHand = (landmarks: any, side: 'left' | 'right') => {
      const prefix = side === 'left' ? 'left' : 'right';
      const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
      const joints = ['Proximal', 'Intermediate', 'Distal'];
      if (side === 'left') joints[0] = 'Metacarpal'; // 親指のみ構造が異なる場合がある

      fingers.forEach((f, fIdx) => {
        joints.forEach((j, jIdx) => {
          const boneName = `${prefix}${f}${j}`;
          const bone = getBone(boneName);
          if (bone) {
            // 関節の曲がりを簡易計算 (MediaPipeの各指の点 4つずつを使用)
            const baseIdx = 1 + fIdx * 4;
            const lm = landmarks;
            const angle = Math.atan2(lm[baseIdx + jIdx + 1].y - lm[baseIdx + jIdx].y, lm[baseIdx + jIdx + 1].x - lm[baseIdx + jIdx].x);
            bone.rotation.z = side === 'left' ? angle : -angle;
          }
        });
      });
    };

    if (res.leftHandLandmarks) mapHand(res.leftHandLandmarks, 'left');
    if (res.rightHandLandmarks) mapHand(res.rightHandLandmarks, 'right');

    // --- Face (Head Rotation, Mouth, Eyes) ---
    if (res.faceLandmarks) {
      const face = res.faceLandmarks;
      if (vrm.expressionManager && face[13] && face[14]) {
        // 口パク
        const mouthOpen = Math.max(0, (face[14].y - face[13].y) * 10.0);
        vrm.expressionManager.setValue('aa', mouthOpen);

        // まばたき (159と145の距離などで判定)
        const eyeR = 1.0 - Math.min(1.0, Math.max(0, (face[386].y - face[374].y) * 20.0));
        
        // 左目ウインクを維持するため、blinkLeftは常に1.0、右目のみトラッキング
        vrm.expressionManager.setValue('blinkLeft', 1.0);
        vrm.expressionManager.setValue('blinkRight', eyeR);
      }

      const head = getBone('head');
      if (head && face[1]) {
        head.rotation.y = -(face[1].x - 0.5);
        head.rotation.x = (face[1].y - 0.5) * 0.5;
      }
    }
  };

  // 3Dランドマーク（デジタルツイン）の更新
  const updateLandmarks3D = (res: any) => {
    if (!vrmsRef.current['local']) return;
    const vrm = vrmsRef.current['local'];
    const poseDots = poseDotsRef.current;
    const handDots = handDotsRef.current;
    
    // アバターのワールドポジションに合わせる
    const headPos = new THREE.Vector3();
    vrm.humanoid.getRawBoneNode('head' as any)?.getWorldPosition(headPos);
    const hipsPos = new THREE.Vector3();
    vrm.humanoid.getRawBoneNode('hips' as any)?.getWorldPosition(hipsPos);
    const lHandPos = new THREE.Vector3();
    vrm.humanoid.getRawBoneNode('leftHand' as any)?.getWorldPosition(lHandPos);
    const rHandPos = new THREE.Vector3();
    vrm.humanoid.getRawBoneNode('rightHand' as any)?.getWorldPosition(rHandPos);

    // ポーズドット
    if (res.poseLandmarks) {
      res.poseLandmarks.forEach((lm: any, i: number) => {
        if (poseDots[i]) {
          const offsetX = (lm.x - 0.5) * 1.5;
          const offsetY = (1.0 - lm.y) * 1.8;
          poseDots[i].position.set(hipsPos.x + offsetX, offsetY, hipsPos.z);
          // visibilityが未定義の場合は常に表示、定義されている場合は0.5以上で表示
          poseDots[i].visible = lm.visibility !== undefined ? lm.visibility > 0.5 : true;
        }
      });
    }

    // 手ドット
    if (res.leftHandLandmarks) {
      res.leftHandLandmarks.forEach((lm: any, i: number) => {
        if (handDots.left[i]) {
          const offsetX = (lm.x - res.leftHandLandmarks[0].x) * 0.4;
          const offsetY = -(lm.y - res.leftHandLandmarks[0].y) * 0.4;
          handDots.left[i].position.set(lHandPos.x + offsetX, lHandPos.y + offsetY, lHandPos.z);
          handDots.left[i].visible = true;
        }
      });
    }
    if (res.rightHandLandmarks) {
      res.rightHandLandmarks.forEach((lm: any, i: number) => {
        if (handDots.right[i]) {
          const offsetX = (lm.x - res.rightHandLandmarks[0].x) * 0.4;
          const offsetY = -(lm.y - res.rightHandLandmarks[0].y) * 0.4;
          handDots.right[i].position.set(rHandPos.x + offsetX, rHandPos.y + offsetY, rHandPos.z);
          handDots.right[i].visible = true;
        }
      });
    }

    // 針金（スケルトン）の表示更新
    const updateLine = (line: THREE.Line, p1: THREE.Vector3, p2: THREE.Vector3, v1: boolean, v2: boolean) => {
      if (!line) return;
      if (v1 && v2) {
        line.geometry.setFromPoints([p1, p2]);
        line.visible = true;
      } else {
        line.visible = false;
      }
    };

    if (res.poseLandmarks) {
      const connections = (window as any).POSE_CONNECTIONS || [];
      connections.forEach(([start, end]: [number, number], idx: number) => {
        if (poseLinesRef.current[idx] && poseDots[start] && poseDots[end]) {
          updateLine(
            poseLinesRef.current[idx], 
            poseDots[start].position, 
            poseDots[end].position,
            poseDots[start].visible,
            poseDots[end].visible
          );
        }
      });
    }

    // 手の針金 (簡略化のため中点から結ぶ)
    const updateHandLines = (side: 'left' | 'right') => {
      const dots = side === 'left' ? handDots.left : handDots.right;
      const lines = side === 'left' ? handLinesRef.current.left : handLinesRef.current.right;
      const conn = (window as any).HAND_CONNECTIONS || [];
      conn.forEach(([start, end]: [number, number], idx: number) => {
        if (lines[idx] && dots[start] && dots[end]) {
          updateLine(lines[idx], dots[start].position, dots[end].position, true, true);
        }
      });
    };
    if (res.leftHandLandmarks) updateHandLines('left');
    if (res.rightHandLandmarks) updateHandLines('right');
  };

  // WebRTC Peer作成
  const createPeer = useCallback(async (targetId: string, isInitiator: boolean) => {
    if (peersRef.current[targetId]) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peersRef.current[targetId] = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) socketRef.current?.emit('candidate', { targetId, candidate: e.candidate });
    };

    const setupDC = (dc: RTCDataChannel) => {
      dataChannelsRef.current[targetId] = dc;
      dc.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'motion' && vrmsRef.current[targetId]) {
          mapMotionToVRM(vrmsRef.current[targetId], data.payload);
        } else if (data.type === 'chat') {
          setSubtitle(`[${targetId.slice(0, 4)}] ${data.payload}`);
          setTimeout(() => setSubtitle(""), 3000);
        }
      };
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('motion');
      setupDC(dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit('offer', { targetId, sdp: offer });
    } else {
      pc.ondatachannel = (e) => setupDC(e.channel);
    }
    return pc;
  }, []);

  // アバター読み込み
  const loadVRM = useCallback(async (url: string, id: string) => {
    // 既に読み込み済み、または読み込み中の場合はスキップ
    if (vrmsRef.current[id] || loadingVrmsRef.current.has(id) || !sceneRef.current) return;
    loadingVrmsRef.current.add(id);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    try {
      const gltf = await new Promise<any>((resolve, reject) => {
        loader.load(
          url,
          resolve,
          (progress) => {
            const percent = Math.round((progress.loaded / (progress.total || 10000000)) * 100);
            if (id === 'local') setLoadingProgress(percent);
          },
          reject
        );
      });
      const vrm = gltf.userData.vrm as VRM;
      if (vrm) {
        vrmsRef.current[id] = vrm;
        sceneRef.current.add(vrm.scene);
        vrm.scene.rotation.y = 0;
        updateLayout();

        // ボーン名の確認用ログ (開発時のみ)
        console.log(`--- VRM Humanoid Bones for ${id} ---`);
        const boneNames: string[] = [];
        const humanBones = (vrm.humanoid as any).humanBones || {};
        // オブジェクトまたは配列の両方に対応
        if (Array.isArray(humanBones)) {
          humanBones.forEach((b: any) => { if(b?.node) boneNames.push(b.node.name) });
        } else {
          Object.entries(humanBones).forEach(([key, b]: [string, any]) => {
            if (b && b.node) boneNames.push(`${key}:${b.node.name}`);
          });
        }
        console.log("Humanoid Nodes:", boneNames);

        // デフォルトポーズ設定 (両腕を自然に下ろした状態)
        const getB = (name: string) => vrm.humanoid?.getNormalizedBoneNode(name as any);
        const lUp = getB('leftUpperArm');
        const rUp = getB('rightUpperArm');

        // 初期ポーズ適用: Z軸回転で腕を体の方へ寄せる
        if (lUp) lUp.rotation.z = -1.2;
        if (rUp) rUp.rotation.z = -1.2;

        if (id === 'local') {
          setStatus("G1:M 準備完了");
          // 自分のロード完了時に一人ならBotを出す
          if (participantsRef.current.length === 0) spawnBot();
        }
      }
      setLoadingProgress(null);
    } catch (e) {
      console.error(`Failed to load VRM for ${id}:`, e);
      if (id === 'local') setStatus("読み込みエラー");
    } finally {
      loadingVrmsRef.current.delete(id); // 成功・失敗どちらでもフラグ解除
    }
  }, [updateLayout]);


  // チャット送信
  const handleChat = useCallback((text: string) => {
    if (!text || !socketRef.current) return;
    setSubtitle(`[自分] ${text}`);
    setChatInput("");
    
    // AI Bot 対応 (一人の時)
    if (Object.keys(dataChannelsRef.current).length === 0 && vrmsRef.current['bot']) {
      setTimeout(() => setSubtitle("[G1:M] こんにちは！"), 1000);
    }

    const data = JSON.stringify({ type: 'chat', payload: text });
    Object.values(dataChannelsRef.current).forEach(dc => {
      if (dc.readyState === 'open') dc.send(data);
    });
    setTimeout(() => setSubtitle(""), 3000);
  }, []);

  // 音声認識の初期化と制御
  useEffect(() => {
    const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechAPI) return;

    const rec = new SpeechAPI();
    rec.lang = 'ja-JP';
    rec.interimResults = false;
    rec.continuous = false;

    rec.onresult = (e: any) => {
      const text = e.results[0][0].transcript;
      handleChat(text);
    };

    rec.onend = () => setIsMicActive(false);
    recognitionRef.current = rec;
  }, [handleChat]);

  // マイクの状態が変わった時の処理
  useEffect(() => {
    if (!recognitionRef.current) return;
    if (isMicActive) {
      try {
        recognitionRef.current.start();
        setStatus("音声入力中...");
      } catch (e) { console.error(e); }
    } else {
      recognitionRef.current.stop();
      setStatus("G1:M 準備完了");
    }
  }, [isMicActive]);

  // カメラの開始 (参照JSのstartCamera相当 - getUserMedia直接使用でiOS/Android対応)
  const startCamera = useCallback(async (mode: 'user' | 'environment' = 'user') => {
    if (!window.Holistic) {
      setStatus("MediaPipeライブラリの読み込み待ち...");
      return;
    }

    try {
      // 既存ストリームを停止
      if (cameraRef.current) {
        try { (cameraRef.current as any).stop?.(); } catch(e) {}
        cameraRef.current = null;
      }

      // --- MediaPipe Holistic 初期化 ---
      const holistic = new window.Holistic({
        locateFile: (file: string) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629/${file}`;
        }
      });
      holistic.setOptions({
        modelComplexity: window.innerWidth < 768 ? 0 : 1,
        smoothLandmarks: true,
        refineFaceLandmarks: true,
        minDetectionConfidence: 0.5
      });
      holistic.onResults((res: any) => {
        lastResultsRef.current = res;

        // スムージング処理
        smoothedResultsRef.current.poseLandmarks = lerpLandmarks(smoothedResultsRef.current.poseLandmarks, res.poseLandmarks);
        smoothedResultsRef.current.leftHandLandmarks = lerpLandmarks(smoothedResultsRef.current.leftHandLandmarks, res.leftHandLandmarks);
        smoothedResultsRef.current.rightHandLandmarks = lerpLandmarks(smoothedResultsRef.current.rightHandLandmarks, res.rightHandLandmarks);
        smoothedResultsRef.current.faceLandmarks = lerpLandmarks(smoothedResultsRef.current.faceLandmarks, res.faceLandmarks);

        const currentRes = smoothedResultsRef.current;

        // 3Dランドマーク更新 (デジタルツイン)
        updateLandmarks3D(currentRes);

        // デバッグ用キャンバス描画 (2Dスケルトン)
        const canvasCtx = debugCanvasRef.current?.getContext('2d');
        if (canvasCtx && debugCanvasRef.current) {
          const canvas = debugCanvasRef.current;
          canvasCtx.save();
          canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
          canvasCtx.translate(canvas.width, 0);
          canvasCtx.scale(-1, 1);

          const utils = (window as any);
          if (utils.drawConnectors && utils.drawLandmarks) {
            if (currentRes.poseLandmarks) {
              utils.drawConnectors(canvasCtx, currentRes.poseLandmarks, (window as any).POSE_CONNECTIONS, {color: '#00FF00', lineWidth: 4});
            }
            if (currentRes.leftHandLandmarks) {
              utils.drawConnectors(canvasCtx, currentRes.leftHandLandmarks, (window as any).HAND_CONNECTIONS, {color: '#CC0000', lineWidth: 5});
            }
            if (currentRes.rightHandLandmarks) {
              utils.drawConnectors(canvasCtx, currentRes.rightHandLandmarks, (window as any).HAND_CONNECTIONS, {color: '#00CC00', lineWidth: 5});
            }
          }
          canvasCtx.restore();
        }

        // ローカルアバターにモーション適用
        if (vrmsRef.current['local']) {
          const vrm = vrmsRef.current['local'];
          mapMotionToVRM(vrm, currentRes);
          // ボーン更新を反映
          if (vrm.humanoid && (vrm.humanoid as any).update) {
            (vrm.humanoid as any).update();
          }
        }
        
        // WebRTCでモーション送信
        const payload = {
          faceLandmarks: currentRes.faceLandmarks ?? null,
          poseLandmarks: currentRes.poseLandmarks ?? null,
          leftHandLandmarks: currentRes.leftHandLandmarks ?? null,
          rightHandLandmarks: currentRes.rightHandLandmarks ?? null,
        };
        const motionData = JSON.stringify({ type: 'motion', payload });
        Object.values(dataChannelsRef.current).forEach(dc => {
          if (dc.readyState === 'open') dc.send(motionData);
        });
      });

      // initialize() を呼ばないとモデルがロードされず最初のsendで落ちる
      setStatus("MediaPipeモデル読込中...");
      await holistic.initialize();
      holisticRef.current = holistic;

      // --- カメラストリーム取得 (getUserMedia直接使用) ---
      const constraints = {
        video: {
          facingMode: { ideal: mode },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 }
        }
      };

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        console.warn("Ideal constraints failed, retrying with video only...", err);
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      const video = document.createElement('video');
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      video.muted = true;
      (video as any).playsInline = true;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = async () => {
          try {
            await video.play();
            resolve();
          } catch (e) { reject(e); }
        };
        video.onerror = () => reject(new Error('Video element error'));
      });

      // ストリームへの参照を保持 (stopCamera用)
      cameraRef.current = { stop: () => stream.getTracks().forEach(t => t.stop()), _video: video } as any;

      setStatus(`カメラ有効 (${mode === 'user' ? '前面' : '背面'})`);

      // --- MediaPipeにフレームを送るループ ---
      // isSendingフラグで非同期send()の多重積み上げを防ぎメモリ暴走を防止
      let isRunning = true;
      let isSending = false;
      const SEND_INTERVAL_MS = 66; // ~15fps
      let lastSendTime = 0;

      const loop = () => {
        if (!isRunning) return;
        requestAnimationFrame(loop);

        const now = performance.now();
        if (!isSending && video.readyState >= 2 && now - lastSendTime >= SEND_INTERVAL_MS) {
          isSending = true;
          lastSendTime = now;
          holisticRef.current?.send({ image: video })
            .catch(() => { /* フレーム送信エラーは無視 */ })
            .finally(() => { isSending = false; });
        }
      };
      loop();

      // コンポーネントアンマウント時に停止できるようrunning flagを管理
      (cameraRef.current as any)._stopLoop = () => { isRunning = false; };

    } catch (err) {
      console.error("Camera access failed:", err);
      setStatus("カメラ起動失敗 - 権限を確認してください");
    }
  }, []);

  // メインループ・初期化
  useEffect(() => {
    // 既に初期化済みの場合はスキップして、多重起動を防ぐ
    if (rendererRef.current || !canvasRef.current) return;

    // --- Socket.IO 初期化 ---
    const socket = io();
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log("Connected to Signaling Server");
      socket.emit('register_role', 'viewer');
    });

    socket.on('participants_list', (list: Participant[]) => {
      setParticipants(list);
      setStatus("他ユーザーの読み込み中...");
      list.forEach(p => loadVRM('/g1-m_chan.glb', p.id));
      list.forEach(p => createPeer(p.id, true));
      // Botの召喚判定はloadVRM('local')内で行うように変更
    });

    socket.on('participant_joined', (p: Participant) => {
      setParticipants(prev => [...prev, p]);
      loadVRM('/g1-m_chan.glb', p.id);
      removeBot();
    });

    socket.on('offer', async (data: any) => {
      const pc = await createPeer(data.from, false);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('answer', { targetId: data.from, sdp: ans });
      }
    });

    socket.on('answer', async (data: any) => {
      await peersRef.current[data.from]?.setRemoteDescription(new RTCSessionDescription(data.sdp));
    });

    socket.on('candidate', async (data: any) => {
      await peersRef.current[data.from]?.addIceCandidate(new RTCIceCandidate(data.candidate));
    });

    socket.on('participant_left', (data: { id: string }) => {
      setParticipants(prev => prev.filter(p => p.id !== data.id));
      const vrm = vrmsRef.current[data.id];
      if (vrm) {
        disposeVRM(vrm);
        delete vrmsRef.current[data.id];
        peersRef.current[data.id]?.close();
        delete peersRef.current[data.id];
        delete dataChannelsRef.current[data.id];
      }
      if (participantsRef.current.length <= 1) spawnBot();
    });

    // --- Three.js 初期化 ---
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvasRef.current,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance"
      });
      rendererRef.current = renderer;
    } catch (err) {
      console.error("Failed to create WebGLRenderer:", err);
      setStatus("WebGL初期化失敗");
      return;
    }

    const camera = new THREE.PerspectiveCamera(35.0, window.innerWidth / window.innerHeight, 0.1, 1000.0);
    camera.position.set(0.0, 1.4, 4.0);

    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 1.3, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const light = new THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(1.0, 2.0, 1.0);
    scene.add(light);
    scene.add(new THREE.GridHelper(20, 20, 0x444444, 0x222222));
    scene.add(landmarkGroupRef.current);

    // 3Dデジタルツインドットの初期化
    // Pose
    for (let i = 0; i < 33; i++) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.02), new THREE.MeshBasicMaterial({ color: 0x00f2ff }));
        dot.visible = false;
        landmarkGroupRef.current.add(dot);
        poseDotsRef.current.push(dot);
    }
    // Hands
    for (let i = 0; i < 21; i++) {
        const ld = new THREE.Mesh(new THREE.SphereGeometry(0.015), new THREE.MeshBasicMaterial({ color: 0x00f2ff }));
        const rd = new THREE.Mesh(new THREE.SphereGeometry(0.015), new THREE.MeshBasicMaterial({ color: 0x7000ff }));
        ld.visible = rd.visible = false;
        landmarkGroupRef.current.add(ld);
        landmarkGroupRef.current.add(rd);
        handDotsRef.current.left.push(ld);
        handDotsRef.current.right.push(rd);
    }

    // 針金(Lines)の初期化
    const poseConn = (window as any).POSE_CONNECTIONS || [];
    for (let i = 0; i < poseConn.length; i++) {
        const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x00f2ff, linewidth: 2 }));
        line.visible = false;
        landmarkGroupRef.current.add(line);
        poseLinesRef.current.push(line);
    }
    const handConn = (window as any).HAND_CONNECTIONS || [];
    ['left', 'right'].forEach(side => {
        for (let i = 0; i < handConn.length; i++) {
            const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: side === 'left' ? 0x00f2ff : 0x7000ff, linewidth: 1.5 }));
            line.visible = false;
            landmarkGroupRef.current.add(line);
            if (side === 'left') handLinesRef.current.left.push(line);
            else handLinesRef.current.right.push(line);
        }
    });

    loadVRM('/g1-m_chan.glb', 'local');

    // --- アニメーションループ ---
    let animationFrameId: number;
    let lastTime = performance.now(); // 初回deltaが巨大にならないよう現在時刻で初期化
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const now = performance.now();
      const delta = Math.min((now - lastTime) / 1000, 0.1); // deltaを最大0.1秒でキャップ
      lastTime = now;
      // vrm.updateが存在する場合のみ呼び出す (bot等の疑似VRMはupdateを持たない場合がある)
      Object.values(vrmsRef.current).forEach(vrm => { if (vrm?.update) vrm.update(delta); });
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // リサイズ対応
    const handleResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      console.log("Cleaning up Three.js and Socket...");
      if (recognitionRef.current) recognitionRef.current.stop();
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      socket.disconnect();
      // カメラのMediaPipeフレームループも停止
      if (cameraRef.current) {
        try { (cameraRef.current as any)._stopLoop?.(); } catch(e) {}
        try { (cameraRef.current as any).stop?.(); } catch(e) {}
      }
      holisticRef.current?.close();
      
      const currentVrms = { ...vrmsRef.current };
      Object.values(currentVrms).forEach(v => disposeVRM(v));
      vrmsRef.current = {};

      Object.values(peersRef.current).forEach(p => p.close());
      peersRef.current = {};
      dataChannelsRef.current = {};

      if (rendererRef.current) {
        rendererRef.current.dispose();
        rendererRef.current = null;
      }
    };
    // 依存配列から重い関数を除外し、初回マウント時のみ実行するようにする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  return (
    <div className="container">
      <header className="header">
        <div className="logo">G1:M DANCE FLOOR</div>
        <div className="participant-count">
          参加者: {participants.length + 1}
        </div>
      </header>

      <div className={`status-indicator ${loadingProgress !== null ? 'loading' : 'ready'}`}>
        <div className="status-dot"></div>
        <span>{loadingProgress !== null ? `読込中 ${loadingProgress}%` : status}</span>
      </div>

      {subtitle && <div id="subtitle-area">{subtitle}</div>}
      
      <div id="scene-container" style={{ position: 'relative' }}>
        <canvas id="three-canvas" ref={canvasRef} style={{ width: '100vw', height: '100vh' }}></canvas>
        <canvas 
          ref={debugCanvasRef} 
          width={640} 
          height={480} 
          style={{ 
            position: 'absolute', 
            top: '20px', 
            right: '20px', 
            width: '160px', 
            height: '120px', 
            background: 'rgba(0,0,0,0.5)', 
            borderRadius: '10px',
            border: '2px solid rgba(255,255,255,0.2)',
            zIndex: 100,
            pointerEvents: 'none'
          }}
        ></canvas>
      </div>

      <div id="chat-wrapper" style={{ position: 'absolute', bottom: '100px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '10px', zIndex: 40 }}>
        <input 
          type="text" 
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleChat(chatInput)}
          placeholder="メッセージを入力..."
          style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '20px', color: 'white', padding: '10px 20px', outline: 'none', width: '250px' }}
        />
        <button onClick={() => handleChat(chatInput)} className="btn-control" style={{ width: '44px', height: '44px' }}>➔</button>
      </div>

      <div className="controls-bar">
        <button className="btn-control active" onClick={() => startCamera('user')}><span>💃</span><span className="btn-label">前面</span></button>
        <button className="btn-control" onClick={() => startCamera('environment')}><span>🦾</span><span className="btn-label">背面</span></button>
        <button 
          className={`btn-control ${isMicActive ? 'active' : ''}`}
          onClick={() => setIsMicActive(!isMicActive)}
        >
          <span>🎤</span><span className="btn-label">マイク</span>
        </button>
        <button className="btn-control danger" onClick={() => window.location.reload()}>
          <span>▢</span><span className="btn-label">終了</span>
        </button>
      </div>
    </div>
  );
};

export default App;