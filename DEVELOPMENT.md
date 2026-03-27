# G1:M 開発・動作確認マニュアル (DEVELOPMENT.md)

このドキュメントでは、ローカル開発環境での動作確認と新機能の使い方について説明します。

## 1. サーバーの起動

まず、Node.jsバックエンドサーバーを起動します。

```bash
# 依存関係のインストール（初回のみ）
npm install

# サーバー起動 (ポート 3000)
npm start
```


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

## 3. 外部デバイス（スマホ等）からの確認

1. **ngrok の起動**:
   ```bash
   ngrok http 3000
   ```
2. **スマホでアクセス**:
   ターミナルに表示された `https://xxxx.ngrok-free.app` をスマホのブラウザで開きます。

---

### 技術スタック
- **3D Engine**: Three.js (VRM / MMD 対応)
- **Tracking**: MediaPipe Holistic (顔・体・手のキャプチャ)
- **AI**: Gemini API / Hugging Face Space (対話・回答生成)
- **Signaling**: Socket.IO / WebRTC (リアルタイム同期)

# まとめ
fuser -k 3000/tcp; sleep 1; npm start
ngrok http 3000
