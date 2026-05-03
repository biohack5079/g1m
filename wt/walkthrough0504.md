# 3Dモデルタップ → QRコード表示機能 実装完了

3Dモデルをタップすると、そのモデルの持ち主が登録したQRコードがポップアップ表示される機能を実装しました。データは Supabase に永続保存されます。

## 実装のポイント

### 1. 3Dタップ検知 (Raycaster)
`THREE.Raycaster` を使用し、ブラウザ上のクリック/タップ座標から3D空間内のVRMモデルを特定するロジックを `App.tsx` に追加しました。

### 2. Supabase 直接連携
Express サーバー (`server.js`) をプロキシとして、Supabase REST API と通信する仕組みを構築しました。
- `GET /api/kampa/wallet/:anonymousId`: QRコード取得
- `POST /api/kampa/wallet/register`: QRコード登録 (Base64)

### 3. 匿名IDのUUID化
`db.ts` で生成する `anonymousId` を UUID v4 形式に変更し、より標準的で衝突しにくいID体系にしました。

### 4. リアルタイム追跡
Socket.IO の `register_role` 時に `anonymousId` を共有するようにしたため、他人のモデルをタップした際も正しいQRコードが引けるようになっています。

## 使い方

1.  **QR登録**: 「カンパ」ボタンから自分のQRコード（画像）をアップロードして登録します。
2.  **QR表示**: 自分や他人の3Dモデルをクリック/タップします。
3.  **確認**: モーダルが表示され、登録されたQRコードが表示されます。

## 修正したファイル
- [server.js](file:///home/me/Documents/d/g1m/g1m/server.js)
- [frontend/src/App.tsx](file:///home/me/Documents/d/g1m/g1m/frontend/src/App.tsx)
- [frontend/src/App.css](file:///home/me/Documents/d/g1m/g1m/frontend/src/App.css)
- [frontend/src/db.ts](file:///home/me/Documents/d/g1m/g1m/frontend/src/db.ts)
- [scratch/supabase_setup.sql](file:///home/me/.gemini/antigravity/brain/fe4b1f54-eb8e-40a7-b109-847c9d2d17fb/scratch/supabase_setup.sql)
