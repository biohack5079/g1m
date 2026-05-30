import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin } from '@pixiv/three-vrm';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { io, Socket } from 'socket.io-client';
import './App.css';
import { getAnonymousId } from './db';
import systemPromptJa from './systemprompt_ja.md?raw';
import systemPromptEn from './systemprompt_en.md?raw';

interface Participant {
  id: string;
  role: string;
  anonymousId?: string;
  nickname?: string;
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
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [isModelHidden, setIsModelHidden] = useState(false);
  const [anonymousId, setAnonymousId] = useState<string>("");
  const [isKampaModalOpen, setIsKampaModalOpen] = useState(false);
  const [isDancing, setIsDancing] = useState(false);
  const [amount, setAmount] = useState(100);
  const [userWalletImage, setUserWalletImage] = useState<string | null>(null);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [tappedWalletImage, setTappedWalletImage] = useState<string | null>(null);
  const [tappedModelId, setTappedModelId] = useState<string>("");
  const [tappedSocketId, setTappedSocketId] = useState<string>("");
  const [nickname, setNickname] = useState<string>("ゲスト");
  const [aiThinking, setAiThinking] = useState(false);
  const [systemLogs, setSystemLogs] = useState<Array<{ message: string, timestamp: string }>>([]);
  const [isLogPanelOpen, setIsLogPanelOpen] = useState(true);
  const [showSystemLog, setShowSystemLog] = useState(true);
  const [tokenGauge, setTokenGauge] = useState<number>(0);
  const [activeNodes, setActiveNodes] = useState<number>(0);
  const [processingNode, setProcessingNode] = useState<string | null>(null);
  const [hasServerLlm, setHasServerLlm] = useState(false);

  const subtitleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusBeforeAiRef = useRef<string>(status);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isModelHiddenRef = useRef(isModelHidden);
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const vrmsRef = useRef<{ [key: string]: VRM }>({});
  const loadingVrmsRef = useRef<Set<string>>(new Set()); // 読み込み中IDのガード
  const recognitionRef = useRef<any>(null);
  const peersRef = useRef<{ [key: string]: RTCPeerConnection }>({});
  const dataChannelsRef = useRef<{ [key: string]: RTCDataChannel }>({});
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  useEffect(() => { isModelHiddenRef.current = isModelHidden; }, [isModelHidden]);
  const holisticRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const threeCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
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
  const handDotsRef = useRef<{ left: THREE.Mesh[], right: THREE.Mesh[] }>({ left: [], right: [] });
  const handLinesRef = useRef<{ left: THREE.Line[], right: THREE.Line[] }>({ left: [], right: [] });

  // 最新の参加者リストをRefで保持（Socket通信のクロージャ対策）
  const participantsRef = useRef<Participant[]>([]);
  useEffect(() => {
    participantsRef.current = participants;
    // スタッフノード（PC）がいるかどうかでアクティブノード数を更新
    if (Array.isArray(participants)) {
      const staffCount = participants.filter(p => p && p.role === 'staff').length;
      setActiveNodes(staffCount);
    }
  }, [participants]);

  const scheduleSubtitleClear = useCallback((delay = 3000) => {
    if (subtitleTimeoutRef.current) {
      clearTimeout(subtitleTimeoutRef.current);
    }
    subtitleTimeoutRef.current = setTimeout(() => {
      setSubtitle("");
    }, delay);
  }, []);

  useEffect(() => {
    return () => {
      if (subtitleTimeoutRef.current) {
        clearTimeout(subtitleTimeoutRef.current);
      }
    };
  }, []);

  const processVideoForMotion = useCallback(async (file: File) => {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;

    await new Promise((resolve) => {
      video.onloadeddata = resolve;
      video.load();
    });

    if (!holisticRef.current) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const processFrame = async () => {
      if (video.paused || video.ended) return;

      ctx?.drawImage(video, 0, 0);
      const imageData = ctx?.getImageData(0, 0, canvas.width, canvas.height);

      if (imageData) {
        await holisticRef.current.send({ image: imageData });
      }

      requestAnimationFrame(processFrame);
    };

    video.play();
    processFrame();

    // 動画終了時に停止
    video.onended = () => {
      setIsDancing(false);
    };
  }, []);

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

  // 匿名IDの初期化
  useEffect(() => {
    getAnonymousId().then(id => {
      setAnonymousId(id);
      // Supabase経由でWallet情報を取得してみる
      fetch(`/api/kampa/wallet/${id}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && data.wallet_image_data) {
            setUserWalletImage(data.wallet_image_data);
          }
        })
        .catch(_err => console.log("Wallet fetch failed."));

      // ニックネームをIndexedDBから取得
      const dbRequest = indexedDB.open("G1M_DB", 1);
      dbRequest.onsuccess = (e: any) => {
        const db = e.target.result;
        const tx = db.transaction(["user_info"], "readonly");
        const getNick = tx.objectStore("user_info").get("nickname");
        getNick.onsuccess = () => { if (getNick.result) setNickname(getNick.result); };
      };
    });
  }, []);

  // ニックネーム保存
  const handleSaveNickname = (newNick: string) => {
    setNickname(newNick);
    const dbRequest = indexedDB.open("G1M_DB", 1);
    dbRequest.onsuccess = (e: any) => {
      const db = e.target.result;
      const tx = db.transaction(["user_info"], "readwrite");
      tx.objectStore("user_info").put(newNick, "nickname");
    };
    if (socketRef.current) {
      socketRef.current.emit('update_nickname', { nickname: newNick });
    }
  };

  // 日本語の女性音声を探すヘルパー
  const getJapaneseFemaleVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    // 1. 日本語(ja-JP)かつ名前に "Google" や "Haruka", "Nanami" などの女性名が含まれるものを優先
    // Ubuntu/Linuxなら "Japanese (Japan)" や特定のエンジン名を検索
    return voices.find(v => v.lang.includes('ja') && (v.name.includes('Female') || v.name.includes('Google') || v.name.includes('Microsoft')))
      || voices.find(v => v.lang.includes('ja'))
      || null;
  };

  // カンパ処理
  const handleDonate = async () => {
    setStatus("カンパ送信中...");
    try {
      const res = await fetch("/api/kampa/donate", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount })
      });
      const message = await res.text();
      setSubtitle(message);

      // お礼のアニメーション
      setIsDancing(true);
      setTimeout(() => setIsDancing(false), 5000); // 5秒間踊る

      // 音声合成でお礼
      if ('speechSynthesis' in window) {
        const uttr = new SpeechSynthesisUtterance(message);
        uttr.voice = getJapaneseFemaleVoice();
        uttr.lang = 'ja-JP';
        uttr.pitch = 1.2; // 少し高くして女性らしく
        window.speechSynthesis.speak(uttr);
      }

      setIsKampaModalOpen(false);
      setStatus("G1:M 準備完了");
    } catch (e) {
      console.error(e);
      setStatus("送金シミュレーション完了 (Backend未接続)");
      setSubtitle(`${amount}円送ったよ、ありがとう！`);
      setIsDancing(true);
      setTimeout(() => setIsDancing(false), 5000);
      setIsKampaModalOpen(false);
    }
  };

  // Wallet登録 (画像アップロード)
  const handleUploadWallet = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target?.result as string;
      setUserWalletImage(base64);

      // Javaバックエンドへ登録
      try {
        await fetch("/api/kampa/wallet/register", {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            anonymousId,
            walletImageData: base64,
            walletType: "AirWallet"
          })
        });
        setStatus("Wallet登録完了");
      } catch (err) {
        console.error("Backend error:", err);
      }
    };
    reader.readAsDataURL(file);
  };

  // 3Dモデルタップ処理 - Raycasterでどのモデルがタップされたか判定
  const handleModelTap = useCallback((event: MouseEvent | TouchEvent) => {
    if (!threeCameraRef.current || !sceneRef.current || !canvasRef.current) return;

    // モーダルが開いている場合はタップを無視
    if (isKampaModalOpen || isQrModalOpen) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const mouse = new THREE.Vector2();

    if ('touches' in event && event.touches.length > 0) {
      const touchEvent = event as TouchEvent;
      const touch = touchEvent.touches[0];
      mouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
    } else {
      const mouseEvent = event as MouseEvent;
      mouse.x = ((mouseEvent.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((mouseEvent.clientY - rect.top) / rect.height) * 2 + 1;
    }

    raycasterRef.current.setFromCamera(mouse, threeCameraRef.current);

    // 各VRMのシーンに対してRaycast
    for (const [id, vrm] of Object.entries(vrmsRef.current)) {
      const intersects = raycasterRef.current.intersectObject(vrm.scene, true);
      if (intersects.length > 0) {
        console.log(`🎯 Tapped model: ${id}`);
        setTappedSocketId(id);
        // setShowHideButton(true); // 中央のボタンは出さない

        // タップされたモデルの anonymousId を特定
        let targetAnonymousId: string | null = null;

        if (id === 'local') {
          // 自分自身
          targetAnonymousId = anonymousId;
        } else if (id === 'bot') {
          // Bot (G1:Mちゃん) → サーバーから専用情報を取得
          setTappedModelId('G1:Mちゃん (AI)');
          setTappedSocketId(id);
          fetch('/api/kampa/wallet/bot')
            .then(res => res.ok ? res.json() : null)
            .then(data => {
              if (data && data.wallet_image_data) setTappedWalletImage(data.wallet_image_data);
              setIsQrModalOpen(true);
            })
            .catch(() => setIsQrModalOpen(true));
          return;
        } else {
          // 他の参加者 → participantsから anonymousId を取得
          const participant = participantsRef.current.find(p => p.id === id);
          targetAnonymousId = participant?.anonymousId || null;
        }

        if (targetAnonymousId) {
          // 他の参加者ならニックネームを表示
          const participant = participantsRef.current.find(p => p.id === id);
          setTappedModelId(id === 'local' ? nickname : (participant?.nickname || id.slice(0, 6)));
          setTappedSocketId(id);

          // Supabase経由でWallet情報を取得
          fetch(`/api/kampa/wallet/${targetAnonymousId}`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
              if (data && data.wallet_image_data) {
                setTappedWalletImage(data.wallet_image_data);
              } else {
                setTappedWalletImage(null);
              }
              setIsQrModalOpen(true);
            })
            .catch(() => {
              setTappedWalletImage(null);
              setIsQrModalOpen(true);
            });
        } else {
          setTappedModelId(id.slice(0, 6));
          setTappedWalletImage(null);
          setIsQrModalOpen(true);
        }
        return; // 最初にヒットしたモデルだけ処理
      }
    }
  }, [anonymousId, isKampaModalOpen, isQrModalOpen]);

  // モーション適用
  const mapMotionToVRM = (vrm: VRM, res: any) => {
    if (!vrm || !res || !vrm.humanoid) return;

    // ボーン取得ヘルパー (正規化されたボーンを取得)
    const getBone = (name: string) => {
      // VRM 1.0 と 0.x の両方のAPIに対応
      return (
        (vrm.humanoid as any).getNormalizedBoneNode?.(name) ||
        (vrm.humanoid as any).getBoneNode?.(name)
      );
    };

    const kalido = (window as any).Kalidokit;
    if (kalido) {
      // --- KalidoKit 統合 ---
      // 1. Face (Head Rotation, Mouth, Eyes)
      if (res.faceLandmarks) {
        const faceRig = kalido.Face.solve(res.faceLandmarks, {
          runtime: 'mediapipe',
          imageSize: { width: 320, height: 240 }
        });
        if (faceRig) {
          const head = getBone('head');
          if (head) {
            head.rotation.y = faceRig.head.y;
            head.rotation.x = faceRig.head.x;
            head.rotation.z = faceRig.head.z;
          }
          if (vrm.expressionManager) {
            vrm.expressionManager.setValue('blinkLeft', 1.0 - faceRig.eye.l);
            vrm.expressionManager.setValue('blinkRight', 1.0 - faceRig.eye.r);
            vrm.expressionManager.setValue('aa', faceRig.mouth.shape.y);
          }
        }
      }

      // 2. Pose (Body & Arms)
      if (res.poseLandmarks) {
        const poseRig = kalido.Pose.solve(res.poseLandmarks, res.poseWorldLandmarks || res.poseLandmarks, {
          runtime: 'mediapipe',
          imageSize: { width: 320, height: 240 }
        });
        if (poseRig) {
          const lUpper = getBone('leftUpperArm');
          const lLower = getBone('leftLowerArm');
          const rUpper = getBone('rightUpperArm');
          const rLower = getBone('rightLowerArm');
          const spine = getBone('spine');

          if (lUpper && poseRig.leftUpperArm) {
            lUpper.rotation.set(poseRig.leftUpperArm.x, poseRig.leftUpperArm.y, poseRig.leftUpperArm.z);
          }
          if (lLower && poseRig.leftLowerArm) {
            lLower.rotation.set(poseRig.leftLowerArm.x, poseRig.leftLowerArm.y, poseRig.leftLowerArm.z);
          }
          if (rUpper && poseRig.rightUpperArm) {
            rUpper.rotation.set(poseRig.rightUpperArm.x, poseRig.rightUpperArm.y, poseRig.rightUpperArm.z);
          }
          if (rLower && poseRig.rightLowerArm) {
            rLower.rotation.set(poseRig.rightLowerArm.x, poseRig.rightLowerArm.y, poseRig.rightLowerArm.z);
          }
          if (spine && poseRig.spine) {
            spine.rotation.set(poseRig.spine.x, poseRig.spine.y, poseRig.spine.z);
          }
        }
      }

      // 3. Left Hand (Fingers)
      if (res.leftHandLandmarks) {
        const leftHandRig = kalido.Hand.solve(res.leftHandLandmarks, 'Left');
        if (leftHandRig) {
          const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
          const joints = ['Proximal', 'Intermediate', 'Distal'];
          fingers.forEach(f => {
            joints.forEach(j => {
              const boneName = `left${f}${j}`;
              const bone = getBone(boneName);
              if (bone) {
                const angleKey = `${f.toLowerCase()}${j}`;
                const angle = leftHandRig[angleKey as keyof typeof leftHandRig] as any;
                if (angle) {
                  bone.rotation.set(angle.x, angle.y, angle.z);
                }
              }
            });
          });
        }
      }

      // 4. Right Hand (Fingers)
      if (res.rightHandLandmarks) {
        const rightHandRig = kalido.Hand.solve(res.rightHandLandmarks, 'Right');
        if (rightHandRig) {
          const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
          const joints = ['Proximal', 'Intermediate', 'Distal'];
          fingers.forEach(f => {
            joints.forEach(j => {
              const boneName = `right${f}${j}`;
              const bone = getBone(boneName);
              if (bone) {
                const angleKey = `${f.toLowerCase()}${j}`;
                const angle = rightHandRig[angleKey as keyof typeof rightHandRig] as any;
                if (angle) {
                  bone.rotation.set(angle.x, angle.y, angle.z);
                }
              }
            });
          });
        }
      }
    } else {
      // --- Fallback manually calculated tracking (Existing design) ---
      if (res.poseLandmarks) {
        const pose = res.poseLandmarks;
        const lUpper = getBone('leftUpperArm');
        const lLower = getBone('leftLowerArm');
        const rUpper = getBone('rightUpperArm');
        const rLower = getBone('rightLowerArm');

        if (lUpper && pose[11] && pose[13]) {
          const dx = pose[13].x - pose[11].x;
          const dy = pose[13].y - pose[11].y;
          const angle = Math.atan2(dy, dx);
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
          rUpper.rotation.z = -angle + Math.PI;
        }
        if (rLower && pose[14] && pose[16]) {
          const angle = Math.atan2(pose[16].y - pose[14].y, pose[16].x - pose[14].x);
          rLower.rotation.z = -angle + Math.PI;
        }
      }

      const mapHand = (landmarks: any, side: 'left' | 'right') => {
        const prefix = side === 'left' ? 'left' : 'right';
        const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
        const joints = ['Proximal', 'Intermediate', 'Distal'];
        if (side === 'left') joints[0] = 'Metacarpal';

        fingers.forEach((f, fIdx) => {
          joints.forEach((j, jIdx) => {
            const boneName = `${prefix}${f}${j}`;
            const bone = getBone(boneName);
            if (bone) {
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

      if (res.faceLandmarks) {
        const face = res.faceLandmarks;
        if (vrm.expressionManager && face[13] && face[14]) {
          const mouthOpen = Math.max(0, (face[14].y - face[13].y) * 10.0);
          vrm.expressionManager.setValue('aa', mouthOpen);
          const eyeR = 1.0 - Math.min(1.0, Math.max(0, (face[386].y - face[374].y) * 20.0));
          vrm.expressionManager.setValue('blinkLeft', 1.0);
          vrm.expressionManager.setValue('blinkRight', eyeR);
        }
        const head = getBone('head');
        if (head && face[1]) {
          head.rotation.y = -(face[1].x - 0.5);
          head.rotation.x = (face[1].y - 0.5) * 0.5;
        }
      }
    }
  };

  // 3Dランドマーク（デジタルツイン）の更新
  const updateLandmarks3D = (res: any) => {
    if (!vrmsRef.current['local']) return;
    const vrm = vrmsRef.current['local'];
    const poseDots = poseDotsRef.current;
    const handDots = handDotsRef.current;

    // VRMの仕様に依存せずボーンを取得
    const getB = (name: string) => (vrm.humanoid as any).getNormalizedBoneNode?.(name) || (vrm.humanoid as any).getBoneNode?.(name);

    // アバターのワールドポジションに合わせる
    const headPos = new THREE.Vector3(); getB('head')?.getWorldPosition(headPos);
    const hipsPos = new THREE.Vector3(); getB('hips')?.getWorldPosition(hipsPos);
    const lHandPos = new THREE.Vector3(); getB('leftHand')?.getWorldPosition(lHandPos);
    const rHandPos = new THREE.Vector3(); getB('rightHand')?.getWorldPosition(rHandPos);

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

    const iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ];

    const pc = new RTCPeerConnection({
      iceServers
    });
    peersRef.current[targetId] = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) socketRef.current?.emit('candidate', { targetId, candidate: e.candidate });
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`📡 Peer ${targetId.slice(0, 5)} ICE state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        console.error("❌ ICE connection failed. Please check your network environment.");
        setStatus("通信エラー: 接続に失敗しました");
      }
    };

    const setupDC = (dc: RTCDataChannel) => {
      dataChannelsRef.current[targetId] = dc;
      dc.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'motion' && vrmsRef.current[targetId]) {
          mapMotionToVRM(vrmsRef.current[targetId], data.payload);
        } else if (data.type === 'chat') {
          setSubtitle(`[${targetId.slice(0, 4)}] ${data.payload}`);
          scheduleSubtitleClear();
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
            const total = progress.total || 10000000;
            const percent = Math.min(100, Math.round((progress.loaded / total) * 100));
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
          humanBones.forEach((b: any) => { if (b?.node) boneNames.push(b.node.name) });
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

        // 初期ポーズ適用: Z軸回転で腕を体の方へ寄せる (鏡像を考慮)
        if (lUp) lUp.rotation.z = -1.2;
        if (rUp) rUp.rotation.z = 1.2;

        if (id === 'local') {
          setStatus("G1:M 準備完了");
          // 常にG1:Mちゃん(AI)を召喚する
          spawnBot();
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

  // --- Language Detection & Translation ---
  /**
   * Detect language: 'ja' for Japanese, 'en' for English
   */
  const detectLanguage = useCallback((text: string): 'ja' | 'en' => {
    // Japanese characters: Hiragana, Katakana, Kanji, Japanese punctuation
    const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3001-\u3008]/g;
    // English: Latin letters and common punctuation
    const englishRegex = /[a-zA-Z0-9\s.,!?\-'":;]/g;

    const japaneseMatches = (text.match(japaneseRegex) || []).length;
    const englishMatches = (text.match(englishRegex) || []).length;

    if (japaneseMatches > englishMatches && japaneseMatches > text.length * 0.1) {
      return 'ja';
    }
    return 'en';
  }, []);

  /**
   * Translate text to target language via API
   */
  const translateText = useCallback(async (text: string, targetLang: 'ja' | 'en'): Promise<string> => {
    try {
      let prompt = '';
      if (targetLang === 'en') {
        prompt = `Translate the following Japanese text to English. Return ONLY the translation without any explanation.\n\nText: ${text}`;
      } else if (targetLang === 'ja') {
        prompt = `次の英文を日本語に翻訳してください。説明なしで翻訳のみを返してください。\n\nText: ${text}`;
      }

      const res = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });

      if (res.ok) {
        const data = await res.json();
        return data.response || data.answer || data.result || text;
      }
    } catch (e) {
      console.error('Translation Error:', e);
    }
    return text;
  }, []);

  const getUserPoseDescription = useCallback(() => {
    const res = smoothedResultsRef.current;
    if (!res || !res.poseLandmarks) return "";

    // poseLandmarks[15] is left wrist, [16] is right wrist
    // poseLandmarks[11] is left shoulder, [12] is right shoulder
    // MediaPipe Y is down, so lower Y means higher up.
    let desc = [];
    if (res.poseLandmarks[15] && res.poseLandmarks[11] && res.poseLandmarks[15].y < res.poseLandmarks[11].y) {
      desc.push("左手を挙げています"); // 15 is Left
    }
    if (res.poseLandmarks[16] && res.poseLandmarks[12] && res.poseLandmarks[16].y < res.poseLandmarks[12].y) {
      desc.push("右手を挙げています"); // 16 is Right
    }

    if (desc.length > 0) {
      return `(ユーザーの現在の状態: ${desc.join('、')})`;
    }
    return "";
  }, []);

  const executeBotAction = useCallback((action: string, botVrm: any) => {
    if (!botVrm || !botVrm.humanoid) return;

    const getBone = (name: string) => botVrm.humanoid.getNormalizedBoneNode(name as any);
    const rUp = getBone('rightUpperArm');
    const lUp = getBone('leftUpperArm');
    const head = getBone('head');
    const spine = getBone('spine');

    const arms = [lUp, rUp].filter(Boolean)
    console.log(`[MOTION] Action: ${action}, Arms: ${arms.length}, Head: ${!!head}`);
    // アクションのキーワード判定 (日本語・英語両方)
    const isHandAction = action.includes('hand') || action.includes('arm') || action.includes('wave') || action.includes('jump') || action.includes('raise') || /手|腕|振|上げ/.test(action);
    const isLeftOnly = action.includes('left') || action.includes('左');
    const isRightOnly = action.includes('right') || action.includes('右');

    let startTime = Date.now();
    const duration = (action.includes('dance') || action.includes('jump')) ? 4000 : 2000; // ダンスやジャンプは長めに

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1.0);

      // 1. 手・腕系の動き
      if (isHandAction && arms.length > 0) {
        const targetArms = [];
        if (isLeftOnly && lUp) targetArms.push(lUp);
        else if (isRightOnly && rUp) targetArms.push(rUp);
        else targetArms.push(...arms);

        targetArms.forEach((arm) => {
          const isRightArm = arm === rUp;
          const downZ = isRightArm ? 1.4 : -1.4;
          const upZ = isRightArm ? -1.5 : 1.5;

          if (progress < 0.2) {
            arm.rotation.z = downZ + ((progress / 0.2) * (upZ - downZ));
          } else if (progress > 0.8) {
            arm.rotation.z = upZ - (((progress - 0.8) / 0.2) * (upZ - downZ));
          } else {
            arm.rotation.z = upZ;
            const speed = (action.includes('wave') || action.includes('jump')) ? 10 : 3;
            arm.rotation.x = Math.sin(progress * Math.PI * speed) * 0.5;
          }
        });
      }

      // 2. 頭・視線系の動き
      if ((action.includes('head') || action.includes('look') || action.includes('think') || action.includes('nod') || action.includes('tilt') || /頭|首|顔|うなず|かしげ/.test(action)) && head) {
        if (action.includes('tilt') || action.includes('かしげ')) {
          head.rotation.z = Math.sin(progress * Math.PI * 2) * 0.3;
        } else if (action.includes('nod') || action.includes('うなず') || action.includes('think')) {
          head.rotation.x = Math.sin(progress * Math.PI * 4) * 0.15;
        } else {
          head.rotation.y = Math.sin(progress * Math.PI * 2) * 0.4;
        }
      }

      // 3. 体・腰系の動き
      if ((action.includes('bow') || action.includes('body') || action.includes('lean') || action.includes('dance') || action.includes('jump') || /辞儀|腰|踊|跳|跳ね/.test(action)) && spine) {
        if (action.includes('dance') || action.includes('踊')) {
          spine.rotation.z = Math.sin(progress * Math.PI * 4) * 0.2;
          spine.rotation.x = Math.sin(progress * Math.PI * 8) * 0.1;
          botVrm.scene.position.y = Math.abs(Math.sin(progress * Math.PI * 8)) * 0.2;
        } else if (action.includes('jump') || action.includes('跳')) {
          botVrm.scene.position.y = Math.abs(Math.sin(progress * Math.PI * 4)) * 0.5;
        } else {
          spine.rotation.x = Math.sin(progress * Math.PI) * (action.includes('bow') ? 0.4 : 0.1);
        }
      }

      // 4. 汎用フォールバック
      if (!isHandAction && !/head|look|think|nod|tilt|頭|首|顔|うなず|かしげ/.test(action) && !/bow|body|lean|dance|jump|辞儀|腰|踊|跳|跳ね/.test(action) && spine) {
        spine.rotation.y = Math.sin(progress * Math.PI * 2) * 0.1;
      }

      if (progress < 1.0) {
        requestAnimationFrame(animate);
      } else {
        if (rUp) { rUp.rotation.z = 1.2; rUp.rotation.x = 0; }
        if (lUp) { lUp.rotation.z = -1.2; lUp.rotation.x = 0; }
        if (head) { head.rotation.x = 0; head.rotation.y = 0; head.rotation.z = 0; }
        if (spine) { spine.rotation.x = 0; spine.rotation.y = 0; spine.rotation.z = 0; }
        botVrm.scene.position.y = 0;
      }
    };

    animate();
  }, []);

  /**
   * Generate system prompt based on detected language
   */
  const generateSystemPrompt = useCallback((language: 'ja' | 'en'): string => {
    return language === 'ja' ? systemPromptJa : systemPromptEn;
  }, []);

  /**
   * AIの回答をパースして字幕表示とモーション実行を行う
   */
  const processAiResponse = useCallback((rawText: string) => {
    let rawAnswer = rawText;

    // Extract action tag
    let actionName = "";
    const tokens = [...rawAnswer.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim());
    for (const token of tokens) {
      if (token.includes(':')) {
        const parts = token.split(':').map((p: string) => p.trim().toLowerCase());
        if (parts.length > 1) {
          actionName = parts[1].replace(/\s+/g, '_');
          break;
        }
      }
      actionName = token.replace(/\s+/g, '_').toLowerCase();
      break;
    }

    // テキストから修飾語（左右）を補足
    const sideModifier = rawAnswer.match(/(左手|右手|左|右|left|right)/i);
    if (sideModifier) {
      const side = sideModifier[1];
      if (/左|left/i.test(side)) actionName = actionName ? `left_${actionName}` : "left_raise";
      else if (/右|right/i.test(side)) actionName = actionName ? `right_${actionName}` : "right_raise";
    }

    rawAnswer = rawAnswer.replace(/\[[^\]]*\]/g, "").trim();

    // Fallback logic
    if (!actionName) {
      const fallbackMatch = rawAnswer.match(/\b(raise_hand|raise hand|wave|bow|nod|look|think|dance|jump|hand_raise|hand raised)\b/i);
      if (fallbackMatch) {
        actionName = fallbackMatch[1].toLowerCase().replace(/\s+/g, '_');
      } else {
        const jpMatch = rawAnswer.match(/(左手|右手|手を上げ|手上げ|上げて|振って|お辞儀|頭を振る|うなず|踊|ジャンプ|跳ね|首をかしげ|かしげる|考える)/);
        if (jpMatch) {
          const jp = jpMatch[1];
          if (/左手|left/.test(jp)) actionName = 'left_raise';
          else if (/右手|right/.test(jp)) actionName = 'right_raise';
          else if (/手を上げ|手上げ|上げて/.test(jp)) actionName = 'raise_hand';
          else if (/振って/.test(jp)) actionName = 'wave';
          else if (/お辞儀/.test(jp)) actionName = 'bow';
          else if (/うなず/.test(jp)) actionName = 'nod';
          else if (/踊|ジャンプ|跳ね/.test(jp)) actionName = 'dance';
          else if (/首をかしげ|かしげる/.test(jp)) actionName = 'tilt_head';
          else if (/考える/.test(jp)) actionName = 'thinking';
        }
      }
    }

    console.log('Processed LLM rawAnswer:', rawAnswer, 'actionName:', actionName);

    // 日本語の回答とモーションを反映
    const displayAnswer = rawAnswer.trim() || (actionName ? `アクション: ${actionName}` : "うまく答えられません。");
    console.log('Final UI Answer:', displayAnswer);
    setSubtitle(`[G1:M] ${displayAnswer}`);
    setAiThinking(false);

    // 実際の回答元タグに基づいてノード名を表示
    if (rawText.includes("【Local PC Node】")) setProcessingNode("PC Node (Brain)");
    else if (rawText.includes("【HF Super Node】")) setProcessingNode("HF Super Node");
    else setProcessingNode("Staff Node (Distributed)");

    setStatus("回答完了");

    const botVrm = vrmsRef.current['bot'];
    if (botVrm) {
      if (actionName) {
        console.log('Executing bot action:', actionName);
        executeBotAction(actionName, botVrm);
      }

      if (botVrm.expressionManager) {
        let startTime = Date.now();
        const lipSync = () => {
          const elapsed = (Date.now() - startTime) / 1000;
          if (elapsed < 3) { // 3秒間パクパク
            botVrm.expressionManager!.setValue('aa', Math.abs(Math.sin(elapsed * 10)));
            requestAnimationFrame(lipSync);
          } else {
            botVrm.expressionManager!.setValue('aa', 0);
          }
        };
        lipSync();
      }
    }
  }, [executeBotAction, statusBeforeAiRef]);

  // チャット送信
  const handleChat = useCallback(async (text: string) => {
    if (!text && !uploadedFile) return;
    if (!socketRef.current) return;

    if (uploadedFile) {
      if (uploadedFile.type.startsWith('video/')) {
        // 動画の場合、モーションキャプチャー
        await processVideoForMotion(uploadedFile);
      } else if (uploadedFile.type.startsWith('text/')) {
        // テキストの場合、RAGとして処理
        const content = await uploadedFile.text();
        // RAG処理（仮）
        setSubtitle(`[RAG] ${content.substring(0, 100)}...`);
      }
      setUploadedFile(null);
      return;
    }

    // Auto-detect language
    const detectedLang = detectLanguage(text);
    console.log(`Chat: Detected language: ${detectedLang}`);

    setSubtitle(`[自分] ${text}`);
    setChatInput("");

    // AI Bot 対応 (一人の時)
    if (Object.keys(dataChannelsRef.current).length === 0 && vrmsRef.current['bot']) {
      // Generate system prompt based on detected language
      const systemPrompt = generateSystemPrompt(detectedLang);
      const poseContext = getUserPoseDescription();
      const fullPrompt = `${systemPrompt}\n\nUser: ${poseContext} ${text}`;

      setTimeout(async () => {
        try {
          statusBeforeAiRef.current = status;
          // 自らの推論リクエスト時にゲージを消費する（スマホ等ではマイナスにもなる）
          setTokenGauge(prev => prev - 5);
          setStatus("G1:M 考え中...");
          setAiThinking(true);
          setSubtitle("[G1:M] 考え中...");
          setProcessingNode("Routing (Checking Local Nodes)...");
          scheduleSubtitleClear(15000); // 長めに設定

          const res = await fetch('/api/llm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: fullPrompt })
          });

          if (res.ok) {
            const data = await res.json();
            processAiResponse(data.text || data.response || data.answer || data.result || "");
          } else {
            const errText = await res.text();
            console.error('LLM API Error:', errText);
            setSubtitle(`[G1:M] APIエラー (${res.status})`);
            setAiThinking(false);
            setStatus("G1:M 接続エラー");
            setProcessingNode(null);
            scheduleSubtitleClear(10000);
          }
        } catch (e) {
          console.error('LLM Error:', e);
          setSubtitle("[G1:M] 接続エラー");
          setAiThinking(false);
          setStatus(statusBeforeAiRef.current || "G1:M 準備完了");
          setProcessingNode(null);
          scheduleSubtitleClear(10000);
        }
      }, 1000);
    }

    // チャットをWebSocketとWebRTC DataChannelの両方で送信 (フォールバック)
    socketRef.current?.emit('chat_message', { text, senderName: nickname });

    const data = JSON.stringify({ type: 'chat', payload: text });
    Object.values(dataChannelsRef.current).forEach(dc => {
      if (dc.readyState === 'open') dc.send(data);
    });
    scheduleSubtitleClear();
  }, [uploadedFile, detectLanguage, translateText, generateSystemPrompt, scheduleSubtitleClear, status, nickname, executeBotAction]);

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
      // 既存ストリームとMediaPipeループ・インスタンスを停止
      if (cameraRef.current) {
        try { (cameraRef.current as any)._stopLoop?.(); } catch (e) { }
        try { (cameraRef.current as any).stop?.(); } catch (e) { }
        cameraRef.current = null;
      }
      if (holisticRef.current) {
        try { holisticRef.current.close(); } catch (e) { }
        holisticRef.current = null;
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
              utils.drawConnectors(canvasCtx, currentRes.poseLandmarks, (window as any).POSE_CONNECTIONS, { color: '#00FF00', lineWidth: 4 });
            }
            if (currentRes.leftHandLandmarks) {
              utils.drawConnectors(canvasCtx, currentRes.leftHandLandmarks, (window as any).HAND_CONNECTIONS, { color: '#CC0000', lineWidth: 5 });
            }
            if (currentRes.rightHandLandmarks) {
              utils.drawConnectors(canvasCtx, currentRes.rightHandLandmarks, (window as any).HAND_CONNECTIONS, { color: '#00CC00', lineWidth: 5 });
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

      // 低解像度化 (320x240) のためのオフスクリーンキャンバス作成
      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = 320;
      offscreenCanvas.height = 240;
      const offscreenCtx = offscreenCanvas.getContext('2d');

      const loop = () => {
        if (!isRunning) return;
        requestAnimationFrame(loop);

        const now = performance.now();
        if (!isSending && video.readyState >= 2 && now - lastSendTime >= SEND_INTERVAL_MS) {
          isSending = true;
          lastSendTime = now;
          if (offscreenCtx) {
            offscreenCtx.drawImage(video, 0, 0, 320, 240);
          }
          holisticRef.current?.send({ image: offscreenCanvas })
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
    // 接続先を明示的に現在のホストにする（Renderへ勝手に繋ぎに行かないようにする）
    const socket = io(window.location.origin);
    socketRef.current = socket;

    socket.on('config', (data: { showSystemLog: boolean }) => {
      setShowSystemLog(data.showSystemLog);
    });

    socket.on('connect', () => {
      console.log("Connected to Signaling Server");
      getAnonymousId().then(anonId => {
        // nickname も含めて登録
        socket.emit('register_role', { role: 'viewer', anonymousId: anonId, nickname: nickname });
      });
    });

    socket.on('server_capabilities', (data: { has_local_llm: boolean }) => {
      setHasServerLlm(data.has_local_llm);
    });

    socket.on('participants_list', (list: Participant[]) => {
      const validList = Array.isArray(list) ? list : [];
      setParticipants(validList);
      setStatus("他ユーザーの読み込み中...");
      // role が staff 以外の参加者のみ 3D表示とP2P接続を行う
      validList.forEach(p => {
        if (p && p.id && p.role !== 'staff') {
          loadVRM('/g1-m_chan.glb', p.id);
          createPeer(p.id, true);
        }
      });
    });

    socket.on('participant_joined', (p: any) => {
      if (!p || !p.id) return;
      setParticipants(prev => {
        if (!Array.isArray(prev)) return [p];
        if (prev.find(existing => existing.id === p.id)) return prev;
        return [...prev, p];
      });
      // PCノード以外ならアバター表示
      if (p.role !== 'staff') {
        loadVRM('/g1-m_chan.glb', p.id);
      }
    });

    socket.on('participant_updated', (data: { id: string, nickname: string }) => {
      if (!data || !data.id) return;
      setParticipants(prev => Array.isArray(prev) ? prev.map(p => p.id === data.id ? { ...p, nickname: data.nickname } : p) : []);
    });

    socket.on('offer', async (data: any) => {
      if (!data || !data.from) return;
      const pc = await createPeer(data.from, false);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('answer', { targetId: data.from, sdp: ans });
      }
    });

    socket.on('answer', async (data: any) => {
      if (!data || !data.from) return;
      await peersRef.current[data.from]?.setRemoteDescription(new RTCSessionDescription(data.sdp));
    });

    socket.on('candidate', async (data: any) => {
      if (!data || !data.from || !data.candidate) return;
      try {
        const pc = peersRef.current[data.from];
        // リモートのSDPがセットされる前にCandidateを追加しようとするとエラーになるため、状態をチェック
        if (pc && pc.remoteDescription && data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (e) {
        console.warn("ICE Candidateの追加に失敗しました（無視して問題ない場合が多いです）:", e);
      }
    });

    socket.on('system_log', (log: { message: string, timestamp: string }) => {
      setSystemLogs(prev => [...prev.slice(-19), log]); // 直近20件を保持
    });

    socket.on('bot_response', (data: { text: string }) => {
      console.log('Received bot_response via socket:', data.text);
      setProcessingNode(null);
      processAiResponse(data.text);
    });

    socket.on('chat_message', (data: { text: string, senderName: string, id: string }) => {
      setSubtitle(`[${data.senderName}] ${data.text}`);
      scheduleSubtitleClear();
    });

    socket.on('distribute_task', (data: { taskId: string, prompt: string }) => {
      // 閲覧者やスマホPWAが推論タスクを分担して負荷分散する（トークン経済圏）
      setProcessingNode("Local WebGPU (Helper)");
      setTimeout(() => {
        setTokenGauge(prev => Math.min(100, prev + 10)); // 推論を手伝うとゲージが上がる
        socketRef.current?.emit('task_result', { taskId: data.taskId, result: "ヘルパーノードからの分散推論結果です" });
        setProcessingNode(null);
      }, 3000);
    });

    socket.on('participant_left', (data: { id: string }) => {
      if (!data || !data.id) return;
      setParticipants(prev => Array.isArray(prev) ? prev.filter(p => p.id !== data.id) : []);
      setActiveNodes(prev => Math.max(1, prev - 1)); // 最低1(自分)
      const vrm = vrmsRef.current[data.id];
      if (vrm) {
        disposeVRM(vrm);
        delete vrmsRef.current[data.id];
        peersRef.current[data.id]?.close();
        delete peersRef.current[data.id];
        delete dataChannelsRef.current[data.id];
      }
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
    threeCameraRef.current = camera;
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

      try {
        // ダンスアニメーション (isDancingがtrueの時)
        if (isDancing && vrmsRef.current['bot']) {
          const bot = vrmsRef.current['bot'];
          const time = now * 0.005;
          bot.scene.rotation.y = Math.sin(time) * 0.2;
          if (bot.humanoid) {
            const lArm = bot.humanoid.getNormalizedBoneNode('leftUpperArm' as any);
            const rArm = bot.humanoid.getNormalizedBoneNode('rightUpperArm' as any);
            if (lArm) lArm.rotation.z = -1.2 + Math.sin(time * 2) * 0.5;
            if (rArm) rArm.rotation.z = 1.2 + Math.sin(time * 2 + Math.PI) * 0.5;
          }

          if (bot.expressionManager) {
            bot.expressionManager.setValue('aa', (Math.sin(time * 10) + 1) * 0.5);
            bot.expressionManager.setValue('happy', 1.0);
          }
        }

        // 各VRMの更新
        Object.values(vrmsRef.current).forEach(vrm => {
          if (vrm?.scene) vrm.scene.visible = !isModelHiddenRef.current;
          if (vrm?.update) vrm.update(delta);
        });

        controls.update();
        renderer.render(scene, camera);
      } catch (e) {
        console.error("Render loop internal error:", e);
      }
    };
    animate();

    // リサイズ対応
    const handleResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);

    // 3Dモデルタップ検出用イベントリスナー
    const canvas = canvasRef.current;
    const onCanvasInteraction = (e: MouseEvent | TouchEvent) => {
      // OrbitControlsのドラッグとの区別（微小な移動ならクリック扱い）
      handleModelTap(e);
    };
    const onCanvasClick = (e: MouseEvent) => onCanvasInteraction(e);
    const onCanvasTouch = (e: TouchEvent) => onCanvasInteraction(e);
    if (canvas) {
      canvas.addEventListener('click', onCanvasClick);
      canvas.addEventListener('touchstart', onCanvasTouch, { passive: true });
    }

    return () => {
      console.log("Cleaning up Three.js and Socket...");
      if (recognitionRef.current) recognitionRef.current.stop();
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      if (canvas) {
        canvas.removeEventListener('click', onCanvasClick);
        canvas.removeEventListener('touchstart', onCanvasTouch);
      }
      socket.disconnect();
      // カメラのMediaPipeフレームループも停止
      if (cameraRef.current) {
        try { (cameraRef.current as any)._stopLoop?.(); } catch (e) { }
        try { (cameraRef.current as any).stop?.(); } catch (e) { }
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
      {/* 3D Scene Container (Background) */}
      <div id="scene-container" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100dvh', zIndex: 0, overflow: 'hidden', backgroundColor: '#000' }}>
        <canvas id="three-canvas" ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}></canvas>
        <canvas
          ref={debugCanvasRef}
          width={640}
          height={480}
          style={{
            position: 'absolute', top: '20px', right: '20px', width: '160px', height: '120px',
            background: 'rgba(0,0,0,0.5)', borderRadius: '10px', border: '2px solid rgba(255,255,255,0.2)',
            zIndex: 10, pointerEvents: 'none'
          }}
        ></canvas>
      </div>

      <header className="header">
        <div className="logo">G1:M</div>
        <div style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <input
            type="text"
            value={nickname}
            onChange={(e) => handleSaveNickname(e.target.value)}
            style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '15px', color: 'white', padding: '5px 12px', fontSize: '12px', width: '80px', outline: 'none' }}
            placeholder="ニックネーム"
            title="クリックして名前を変更"
          />
          <div className="participant-count">
            参加者: {participants.length + 1}
          </div>
        </div>
      </header>

      <div style={{ position: 'absolute', top: 60, left: 10, zIndex: 100, background: 'rgba(0,0,0,0.5)', padding: '10px', borderRadius: '8px', color: 'white', pointerEvents: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%', backgroundColor: (activeNodes > 0) ? '#0f0' : '#f00', marginRight: '8px', boxShadow: (activeNodes > 0) ? '0 0 12px #0f0' : 'none' }}></span>
          <span style={{ fontWeight: 'bold' }}>PC NODE: {(activeNodes > 0) ? 'ACTIVE' : 'DISCONNECTED'}</span>
        </div>
        <div style={{ marginTop: '5px' }}>
          Token Gauge: {tokenGauge}%
          <div style={{ width: '100px', height: '10px', background: '#333', borderRadius: '5px', marginTop: '2px' }}>
            <div style={{ width: `${tokenGauge}%`, height: '100%', background: 'cyan', borderRadius: '5px', transition: 'width 0.3s' }}></div>
          </div>
        </div>
        {aiThinking && (
          <div style={{ marginTop: '5px', fontSize: '11px', color: '#ffd700', fontWeight: 'bold' }}>
            ⚡ RUNNING ON: {processingNode}
          </div>
        )}
      </div>

      <div className={`status-indicator ${loadingProgress !== null ? 'loading' : (aiThinking ? 'thinking' : 'ready')}`}>
        <div className="status-dot" style={{
          backgroundColor: loadingProgress !== null ? '#fff' :
            aiThinking ? '#ffd700' :
              (hasServerLlm || activeNodes > 0 ? '#0f0' : '#f00')
        }}></div>
        <span>
          {loadingProgress !== null ? `読込中 ${loadingProgress}%` :
            aiThinking ? `推論中: ${processingNode}` :
              (hasServerLlm || activeNodes > 0 ? "PC Node Active (Local First)" : "Disconnected (No AI Node)")}
        </span>
      </div>

      {subtitle && <div id="subtitle-area" style={{ zIndex: 50 }}>{subtitle}</div>}

      <div id="chat-wrapper" style={{ position: 'absolute', bottom: '100px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '10px', zIndex: 40, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
        <input
          type="text"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleChat(chatInput);
              (e.target as HTMLInputElement).blur(); // iPhoneキーボードを閉じる
            }
          }}
          placeholder="メッセージを入力..."
          style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '20px', color: 'white', padding: '10px 20px', outline: 'none', width: '250px' }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,text/*"
          onChange={(e) => setUploadedFile(e.target.files?.[0] || null)}
          style={{ display: 'none' }}
        />
        <button type="button" className="btn-control" onClick={() => fileInputRef.current?.click()} style={{ width: '44px', height: '44px', background: 'rgba(100,150,255,0.3)' }} title="動画またはテキストファイルを選択して送信">📎</button>
        <button onClick={() => handleChat(chatInput)} className="btn-control" style={{ width: '44px', height: '44px' }}>➔</button>
      </div>

      {/* システムログパネル */}
      {showSystemLog && (
        <div className={`system-log-panel ${isLogPanelOpen ? 'open' : 'closed'}`} onClick={() => !isLogPanelOpen && setIsLogPanelOpen(true)}>
          <div className="log-panel-header" onClick={(e) => { e.stopPropagation(); setIsLogPanelOpen(!isLogPanelOpen); }}>
            <span>コンソール</span>
            <button className="log-close-btn">{isLogPanelOpen ? '▼' : '▲'}</button>
          </div>
          {isLogPanelOpen && (
            <>
              <div className="log-content" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
                {systemLogs.length === 0 ? (
                  <div className="log-empty">待機中...</div>
                ) : (
                  systemLogs.map((log, i) => (
                    <div key={i} className="log-entry">
                      <span className="log-time">[{log.timestamp}]</span>
                      <span className="log-msg">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
              {/* 将来の広告・告知用拡張エリア */}
              <div className="log-promo-area">
                {aiThinking ? (
                  <div className="promo-loading">
                    <span className="promo-text">AI回答生成中...</span>
                  </div>
                ) : (
                  <div className="promo-idle">G1:M v1.0.0</div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {isModelHidden && (
        <div style={{ position: 'absolute', bottom: '20px', right: '20px', zIndex: 50 }}>
          <button onClick={() => setIsModelHidden(false)} className="btn-control" style={{ background: 'rgba(100,255,150,0.3)' }}>モデルを表示</button>
        </div>
      )}

      {uploadedFile && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 50, background: 'rgba(0,0,0,0.9)', padding: '30px', borderRadius: '10px', textAlign: 'center', color: 'white' }}>
          <p>{uploadedFile.type.startsWith('video/') ? '動画を読み込み中...' : 'テキストを読み込み中...'}</p>
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>{uploadedFile.type.startsWith('video/') ? 'モーションキャプチャーを処理しています' : 'テキストをRAGとして処理しています'}</p>
          <p style={{ fontSize: '12px', marginTop: '10px' }}>📎 {uploadedFile.name}</p>
        </div>
      )}

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
        <button
          className={`btn-control ${isKampaModalOpen ? 'active' : ''}`}
          onClick={() => {
            setIsKampaModalOpen(true);
            if ('speechSynthesis' in window) {
              const uttr = new SpeechSynthesisUtterance("応援よろしくね？");
              uttr.lang = 'ja-JP';
              window.speechSynthesis.speak(uttr);
            }
          }}
        >
          <span>💰</span><span className="btn-label">カンパ</span>
        </button>
      </div>

      {/* カンパ用モーダル */}
      {isKampaModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>G1:Mちゃんを応援する</h3>
            <div className="qr-container">
              <p>G1:Mの投げ銭用QR</p>
              <img src="/z1m/AirWallet/g1-m_chan.jpeg" alt="G1:M QR" className="qr-image" />
            </div>

            <div className="donation-form">
              <div className="input-group">
                <label>自分のAirWalletを登録 (任意)</label>
                <input type="file" accept="image/*" onChange={handleUploadWallet} />
                {userWalletImage && <div className="wallet-mini-preview"><img src={userWalletImage} alt="Your Wallet" /><span>登録済</span></div>}
              </div>

              <div className="input-group">
                <label>金額 (円)</label>
                <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
              </div>

              <div className="modal-btns">
                <button className="btn-action kampa" onClick={handleDonate}>カンパを送る</button>
                <button className="btn-action close" onClick={() => setIsKampaModalOpen(false)}>閉じる</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* QRコード表示モーダル (3Dモデルタップ時) */}
      {isQrModalOpen && (
        <div className="modal-overlay" onClick={() => setIsQrModalOpen(false)}>
          <div className="modal-content qr-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{tappedModelId} のQRコード</h3>
            <div className="qr-container">
              {tappedWalletImage ? (
                <img src={tappedWalletImage} alt="Wallet QR" className="qr-image" />
              ) : (
                <div className="qr-placeholder">
                  <p>💳</p>
                  <p>QRコード未登録</p>
                  <p className="qr-hint">
                    {tappedModelId === nickname
                      ? '自分のQRはカンパから登録できます'
                      : '相手のQRは未登録です'}
                  </p>
                </div>
              )}
            </div>

            <div className="modal-btns">
              <button
                className="btn-action danger"
                onClick={() => {
                  const targetId = tappedSocketId;
                  const vrm = vrmsRef.current[targetId];
                  if (vrm) {
                    disposeVRM(vrm);
                    delete vrmsRef.current[targetId];
                    if (targetId !== 'local' && targetId !== 'bot') {
                      peersRef.current[targetId]?.close();
                      delete peersRef.current[targetId];
                      delete dataChannelsRef.current[targetId];
                      setParticipants(prev => prev.filter(p => p.id !== targetId));
                    }
                  }
                  setIsQrModalOpen(false);
                }}
                style={{ background: 'rgba(255, 50, 50, 0.3)', color: 'white' }}
              >
                退出/非表示
              </button>
              <button className="btn-action close" onClick={() => setIsQrModalOpen(false)}>閉じる</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;