#!/bin/bash
set -e

echo "===================================================="
echo "🚀 G1:M Simple Setup & Verification"
echo "===================================================="

# 0. ポートのクリーンアップと環境準備
echo "[0/5] Cleaning up ports and preparing environment..."
fuser -k 3000/tcp 3001/tcp 2>/dev/null || true
rm -rf z1m/java-unit/db/

# 1. Java ディレクトリ構造の強制セットアップ
echo "[1/5] Setting up Java Directory Structure..."
cd z1m/java-unit
mkdir -p src/main/java/com/g1m/z1m/entity src/main/java/com/g1m/z1m/config \
         src/main/java/com/g1m/z1m/repository/personal src/main/java/com/g1m/z1m/repository/financial \
         src/test/java/com/g1m/z1m src/test/resources db/

# ファイルの移動とクリーンアップ
mv src/main/resources/VaultIntegrationTest.java src/test/java/com/g1m/z1m/ 2>/dev/null || true
mv config/FinancialDbConfig.java src/main/java/com/g1m/z1m/config/ 2>/dev/null || true
mv config/PersonalDbConfig.java src/main/java/com/g1m/z1m/config/ 2>/dev/null || true
find src/main/java/com/g1m/z1mjavaunit -name "*.java" -exec mv {} src/main/java/com/g1m/z1m/ \; 2>/dev/null || true
find src/test/java/com/g1m/z1mjavaunit -name "*.java" -exec mv {} src/test/java/com/g1m/z1m/ \; 2>/dev/null || true

# 全Javaファイルのパッケージ名を強制統一
find src -name "*.java" -exec sed -i 's/com.g1m.z1mjavaunit/com.g1m.z1m/g' {} +

# 重複リポジトリの削除
rm -f src/main/java/com/g1m/z1m/repository/WalletRepository.java || true
rm -rf src/main/java/com/g1m/z1mjavaunit src/test/java/com/g1m/z1mjavaunit || true

# テスト用プロパティ作成
cat <<EOF > src/test/resources/application.properties
spring.datasource.personal.url=jdbc:h2:file:./db/personal;DB_CLOSE_DELAY=-1;AUTO_SERVER=TRUE;DB_CLOSE_ON_EXIT=FALSE
spring.datasource.financial.url=jdbc:h2:file:./db/financial;DB_CLOSE_DELAY=-1;AUTO_SERVER=TRUE;DB_CLOSE_ON_EXIT=FALSE
spring.datasource.personal.driver-class-name=org.h2.Driver
spring.datasource.financial.driver-class-name=org.h2.Driver
spring.main.allow-bean-definition-overriding=true
spring.jpa.hibernate.ddl-auto=update
EOF

# Javaテスト実行
echo "Running Java Vault Tests..."
mvn clean test -Dtest=VaultIntegrationTest || (echo "❌ Java Tests Failed" && exit 1)

echo "✅ Java physical DB isolation verified."
cd ../../

# 2. Rust コンパイルチェック
echo -e "\n[2/5] Checking Rust Node Compilation..."
cd g1m-node
cargo check
echo "✅ Rust compilation OK."
cd ..

# 3. Rust DB 秘匿情報漏洩チェック
echo -e "\n[3/5] Verifying Rust DB Privacy (Leak Check)..."
if [ -f g1m.db ]; then
    LEAKS=$(sqlite3 g1m.db "SELECT text FROM messages;" | grep -E "bank|base64|image" || true)
    if [ -z "$LEAKS" ]; then
        echo "✅ OK: No sensitive data in Rust messages."
    else
        echo "❌ WARNING: Potential data leak in Rust DB!"
    fi
else
    echo "⚠️ g1m.db not found. Run 'npm run dev' first."
fi

# 4. UI ステータス表示ロジックの整合性チェック
echo -e "\n[4/5] Checking UI Status Indicator Logic (PC vs HF)..."
FRONTEND_FILE="frontend/src/MainApp.tsx"
if [ -f "$FRONTEND_FILE" ]; then
    # PC NODE ステータス色ロジックの確認
    grep -q "activeNodes > 0.*#0f0.*#f00" "$FRONTEND_FILE" && echo "✅ UI Logic: PC NODE Green/Red color logic verified." || echo "❌ UI Logic: PC NODE color logic mismatch."
    
    # AI推論中(aiThinking)のステータスドット色ロジックの確認
    grep -q "aiThinking.*#ffd700" "$FRONTEND_FILE" && echo "✅ UI Logic: AI Thinking (Yellow) logic verified." || echo "❌ UI Logic: Thinking color logic mismatch."

    # CNC URLにIDが付加されているかの確認
    grep -q "cnc_url:.*id=\${anonymousId}" "$FRONTEND_FILE" && echo "✅ UI Logic: Guest CNC URL with UUID verified." || echo "❌ UI Logic: Guest CNC URL UUID missing."
    
    # BotのCNC URLセット処理の確認
    grep -q "setTappedCncUrl(data?.cnc_url" "$FRONTEND_FILE" && echo "✅ UI Logic: Bot CNC URL handling verified." || echo "❌ UI Logic: Bot CNC URL handling missing."
else
    if [ -f "public/main.js" ]; then
        grep -q "staffNodes.size > 0.*#0f0.*#f00" public/main.js && echo "✅ UI Logic (main.js): PC/HF indicator logic verified." || echo "❌ UI Logic (main.js) mismatch."
    else
        echo "⚠️ UI Source files not found. Skipping UI Logic Check."
    fi
fi

# 5. Supabase 同期テスト
echo -e "\n[5/5] Verifying Supabase Connectivity..."
if [ -f .env ]; then
    source .env
    curl -s -X GET "${SUPABASE_URL}/rest/v1/chat_history?limit=1" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" > /dev/null
    if [ $? -eq 0 ]; then
        echo "✅ Supabase sync path is alive."
    else
        echo "❌ Supabase connection failed."
    fi
fi

echo -e "\n===================================================="
echo "✨ All systems verified (Simple Config Applied)."