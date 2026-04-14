# G1:M 開発・動作確認マニュアル (DEVELOPMENT.md)

このドキュメントでは、ローカル開発環境での動作確認と新機能の使い方について説明します。

## 1. セットアップと起動

### 初回セットアップ
ルートディレクトリとフロントエンドディレクトリの両方で依存関係をインストールします。

```bash
npm run build  # ルートの package.json に定義されたビルドスクリプト
```

### 開発モード (推奨)
バックエンド (3000) と フロントエンド (3001) を同時に起動します。
コードの変更が即座にブラウザに反映されます。

```bash
npm run dev
```
アクセス先: http://localhost:3001

### 本番確認モード
フロントエンドをビルドし、Express サーバー経由で配信します。

```bash
# フロントエンドのビルド
cd frontend && npm run build && cd ..

# サーバー起動 (ポート 3000)
npm start
```
アクセス先: http://localhost:3000

### ポートが既に使用されている場合 (EADDRINUSE)
もし「Error: listen EADDRINUSE: address already in use :::3000」と表示された場合は、以下のコマンドで残っているプロセスを終了してから再試行してください。

```bash
fuser -k 3000/tcp
```

## 2. 新機能の使い方

### AIエージェントモード
会議室に自分一人の時、自動的に**「G1:Mちゃん (AI)」**が出現します。
- **音声認識**: 画面下のマイクボタンを押して話しかけてください。
- **対話**: AIが内容を解釈し、リップシンク（口パク）を伴う「喋り」で返答します。
- **自動解除**: 他のユーザー（スマホ等）が接続すると、AIは自動で退席し通常の会議モードになります。

### Zoom & TikTok スタイル UI
- **PC版 (Zoom風)**: 複数人参加時、グリッド形式で全員が表示されます。
- **スマホ版 (TikTok風)**: 全画面表示になり、左右にスワイプすることで別のアバターにフォーカスできます。

### デフォルトアームポーズ（問題切り分け用）
MediaPipeカメラなしの状態で、アバターは以下のデフォルト姿勢をとります：
- **右手**: 前方向（rotation.x = -π/2）
- **左手**: 上方向（rotation.z = -π/2）

これにより「カメラなし状態のT-pose」と「MediaPipeが動作しているか」を視覚的に切り分けられます。

## 3. 外部デバイス（スマホ等）からの確認

### ⚠️ ngrok について
ngrok の無料プランは **帯域制限（ERR_NGROK_725）** があり、GLBファイル（数十MB）を
繰り返し転送するとすぐ上限に達します。**代わりに cloudflared を使用してください。**

GLBファイルには7日間のブラウザキャッシュが設定されているため、
一度ダウンロードされれば2回目以降は転送コストがかかりません。

### cloudflared（推奨・無料・帯域無制限）

インストール（初回のみ）:
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o ~/cloudflared && chmod +x ~/cloudflared
```

使い方:
```bash
# ターミナル1
npm run dev

# ターミナル2
~/cloudflared tunnel --url http://localhost:3001
```
表示された `https://xxxx.trycloudflare.com` のURLにアクセスします。

> **注意**: Quick Tunnel のURLは起動のたびに変わります。
> 固定URLが必要な場合は Cloudflare アカウントを作成して Named Tunnel を設定してください。
> https://developers.cloudflare.com/cloudflare-one/connections/connect-apps

### 本番ビルド版を公開する場合
```bash
cd frontend && npm run build && cd ..
npm start

# ターミナル2
~/cloudflared tunnel --url http://localhost:3000
```

## 4. 技術スタック・設計メモ

| レイヤー | 技術 |
|---|---|
| **3D Engine** | Three.js (VRM / MMD 対応) |
| **Tracking** | MediaPipe Holistic (顔・体・手のキャプチャ) |
| **AI** | Gemini API / Hugging Face Space |
| **Signaling** | Socket.IO / WebRTC |
| **Frontend** | React + Vite + TypeScript |

### React StrictMode を外している理由
`main.tsx` で `<StrictMode>` を意図的に除去しています。
StrictMode は開発時に `useEffect` を **mount → cleanup → mount** と2回発火させますが、
Three.js / MediaPipe / WebRTCのような重い副作用と組み合わせると
GLBフェッチが中断される（`DOMException: The operation was aborted`）問題が発生するためです。

### MediaPipeメモリ暴走対策
`isSending` フラグで非同期 `holistic.send()` の多重積み上げを防いでいます。
`async/await` ループで `await send()` していると、処理が遅い場合に
`requestAnimationFrame` が次々と新しいコールスタックを積み上げてメモリが爆増します。

```
// NG: awaitが積み重なる
const loop = async () => { await holistic.send(...); requestAnimationFrame(loop); }

// OK: isSendingフラグで多重発火をブロック
const loop = () => {
  requestAnimationFrame(loop);
  if (!isSending) {
    isSending = true;
    holistic.send(...).finally(() => { isSending = false; });
  }
};
```

---

# ワークフロー早見表

## ローカル開発（スマホ確認あり）

```bash
# ターミナル1（開発サーバー。ファイル保存で自動更新）
fuser -k 3000/tcp; fuser -k 3001/tcp; npm run dev

# ターミナル2（外部公開。これだけでスマホからアクセス可）
~/cloudflared tunnel --url http://localhost:3001
```

これだけでOK。`npm run build` は不要（Vite の HMR が動いているため）。

## 本番デプロイ（Render.com）

Render.com は GitHub push で自動デプロイされます。
push 前に以下を確認してください：

```bash
# 1. ローカルでビルドエラーがないか確認
npm run build

# 2. 本番動作を手元で確認したい場合（任意）
npm start  # http://localhost:3000 で確認
~/cloudflared tunnel --url http://localhost:3000

# 3. 問題なければ git push
git add -A && git commit -m "変更内容" && git push
```

> **render.yaml の設定**
> `buildCommand: "npm install && npm run build"`
> Render 上でも React フロントをビルドしてから `npm start` (Express) で配信します。

# ショートカット
npm run dev
~/cloudflared tunnel --url http://localhost:3001
cd frontend
npm run build
git add .
git commit -m "change"
git push -u origin main
