# G1:M システム一斉検証手順

## 1. Java基幹系 (Vault)
物理的に分離されたH2データベース（Personal/Financial）への書き込みと、QRコード（Base64）の永続化を検証します。
```bash
mvn clean test -Dtest=VaultIntegrationTest
```

## 2. Rust/P2P整合性
Rust側のSQLiteに秘匿情報（銀行名、Base64データ）が漏洩していないか、メッセージのみが保存されているかを確認します。

## 3. Supabase同期
チャット履歴がクラウド（Supabase）へ正常に送信され、永続化されているかAPI経由で確認します。

## 4. 実行スクリプト
プロジェクトルートの `verify_all_systems.sh` を実行することで、上記すべてを自動検証できます。

# Rust側のDB（プロジェクトルートにある g1m.db）をチェック
cd ~/g1m/
echo "--- Rust SQLite DBのテーブル一覧 (金融/QRデータがないことを確認) ---"
sqlite3 g1m.db ".tables"

# 秘匿情報（bank_nameやwallet_image_data）がRust側に漏れていないか検索
echo "--- 秘匿情報の漏洩チェック（何も表示されなければ安全） ---"
sqlite3 g1m.db "SELECT * FROM messages;" | grep -E "bank|base64|image"

# .envから情報を取得（手動で設定している場合は置き換えてください）
source .env 2>/dev/null

echo "--- Supabase 接続・格納テスト ---"
# ダミーデータの投入テスト (Supabase REST API)
curl -X POST "${SUPABASE_URL}/rest/v1/chat_history" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"sender_name\": \"TEST_RUNNER\", \"content\": \"Supabase Integration Test at $(date)\"}"

# 格納された最新5件の確認
echo -e "\n--- Supabase内の最新履歴データ ---"
curl -X GET "${SUPABASE_URL}/rest/v1/chat_history?select=*&order=created_at.desc&limit=5" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}"


  # ポート使用状況の確認（Rust:3000, P2P:4001, Java:8080）
echo "--- ネットワークポート稼働確認 ---"
netstat -tuln | grep -E "3000|4001|8080"

# ログからエラーの有無をスキャン
echo "--- 異常ログの有無を確認 ---"
grep -i "error" g1m_node.log 2>/dev/null || echo "No errors in Rust log."
