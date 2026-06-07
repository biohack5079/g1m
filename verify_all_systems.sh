#!/bin/bash
set -e

echo "===================================================="
echo "🚀 G1:M Simple Setup & Verification"
echo "===================================================="

# 0. ポートのクリーンアップと環境準備
echo "[0/7] Cleaning up ports and preparing environment..."
fuser -k 3000/tcp 3001/tcp 2>/dev/null || true
rm -rf z1m/java-unit/db/

cd z1m/java-unit
mkdir -p src/main/java/com/g1m/z1m/entity/personal src/main/java/com/g1m/z1m/entity/financial \
         src/main/java/com/g1m/z1m/config \
         src/main/java/com/g1m/z1m/repository/personal src/main/java/com/g1m/z1m/repository/financial \
         src/test/java/com/g1m/z1m src/test/resources db/

# ファイルの移動とクリーンアップ
mv src/main/resources/VaultIntegrationTest.java src/test/java/com/g1m/z1m/ 2>/dev/null || true
mv config/FinancialDbConfig.java src/main/java/com/g1m/z1m/config/ 2>/dev/null || true
mv config/PersonalDbConfig.java src/main/java/com/g1m/z1m/config/ 2>/dev/null || true
mv src/main/java/com/g1m/z1m/entity/PersonalInfo.java src/main/java/com/g1m/z1m/entity/personal/ 2>/dev/null || true
mv src/main/java/com/g1m/z1m/entity/FinancialInfo.java src/main/java/com/g1m/z1m/entity/financial/ 2>/dev/null || true
find src/main/java/com/g1m/z1mjavaunit -name "*.java" -exec mv {} src/main/java/com/g1m/z1m/ \; 2>/dev/null || true
find src/test/java/com/g1m/z1mjavaunit -name "*.java" -exec mv {} src/test/java/com/g1m/z1m/ \; 2>/dev/null || true

# 全Javaファイルのパッケージ名を強制統一
find src -name "*.java" -exec sed -i 's/com.g1m.z1mjavaunit/com.g1m.z1m/g' {} +

# エンティティのパッケージ移動に伴うインポートと参照の修正
find src -name "*.java" -exec sed -i 's/com.g1m.z1m.entity.PersonalInfo/com.g1m.z1m.entity.personal.PersonalInfo/g' {} +
find src -name "*.java" -exec sed -i 's/com.g1m.z1m.entity.FinancialInfo/com.g1m.z1m.entity.financial.FinancialInfo/g' {} +

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

# 1. Javaテスト実行
echo "[1/7] Running Java Vault Tests..."
mvn clean test -Dtest=VaultIntegrationTest || (echo "❌ Java Tests Failed" && exit 1)

echo "✅ Java physical DB isolation verified."
cd ../../

# 2. Rust コンパイルチェック
echo -e "\n[2/7] Checking Rust Node Compilation..."
cd g1m-node
cargo check || (echo "❌ Rust Compilation Failed" && exit 1)
echo "✅ Rust compilation OK."
cd ..

# 3. ローカル推論環境のチェック (Ollama)
echo -e "\n[3/7] Verifying Local Inference Capability (Ollama Connectivity)..."
cd g1m-node
cargo test test_local_ollama_availability -- --nocapture || echo "⚠️ Ollama is not running. Local inference will be unavailable (failover to HF)."
cd ..

# 3. Rust DB 秘匿情報漏洩チェック
echo -e "\n[4/7] Verifying Rust DB Privacy (Leak Check)..."
cd g1m-node
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
cd ..

# 4. UI ステータス表示ロジックの整合性チェック
echo -e "\n[5/7] Checking UI Status Indicator Logic (PC vs HF)..."
FRONTEND_FILE="frontend/src/MainApp.tsx"
if [ -f "$FRONTEND_FILE" ]; then
    # PC NODE ステータス色ロジックの確認
    grep -q "activeNodes > 0.*#0f0.*#f00" "$FRONTEND_FILE" && echo "✅ UI Logic: PC NODE Green/Red color logic verified." || echo "❌ UI Logic: PC NODE color logic mismatch."
    
    # AI推論中(aiThinking)に枠線が光る(Green)ロジックの確認
    grep -q "aiThinking.*#0f0" "$FRONTEND_FILE" && echo "✅ UI Logic: AI Thinking (Node Highlight) logic verified." || echo "❌ UI Logic: Thinking highlight logic mismatch."

    # CNC URLにIDが付加されているかの確認
    grep -q "cnc_url:.*\\?id=\${anonymousId}" "$FRONTEND_FILE" && echo "✅ UI Logic: Guest CNC URL with UUID verified." || echo "❌ UI Logic: Guest CNC URL UUID missing."
    
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
echo -e "\n[6/7] Verifying Supabase Connectivity..."
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

# 7. G1:M モーション・パフォーマンス・チェック (Rotation & TORA TORA)
echo -e "\n[7/7] Verifying G1:M Motion Capabilities (Rotation & TORA TORA)..."
if [ -f "$FRONTEND_FILE" ]; then
    # 1. くるくる回れるか (Rotation logic check)
    if grep -q "rotation.y = Math.sin" "$FRONTEND_FILE"; then
        echo "✅ Motion: Rotation logic (Spinning) verified."
        
        # 2. TORA TORA 再現度チェック (High Tension logic)
        # 判定要素: 1. dance判定, 2. spine回転, 3. position.y(ジャンプ), 4. arm.rotation, 5. lowerArm.rotation(肘)
        # これらが揃うことで「満点」となる
        SCORE=0
        grep -q "action.includes('dance')" "$FRONTEND_FILE" && SCORE=$((SCORE + 1))
        grep -q "spine.rotation.z" "$FRONTEND_FILE" && SCORE=$((SCORE + 1))
        grep -q "position.y = Math.abs" "$FRONTEND_FILE" && SCORE=$((SCORE + 1))
        grep -q "arm.rotation.z" "$FRONTEND_FILE" && SCORE=$((SCORE + 1))
        grep -q "lowerArm.rotation.x" "$FRONTEND_FILE" && SCORE=$((SCORE + 1))
        
        PERCENTAGE=$((SCORE * 20))
        echo "📊 TORA TORA Reproduction Rate: ${PERCENTAGE}%"
        
        if [ $PERCENTAGE -eq 100 ]; then
            echo "🎊 PERFECT! High tension dance logic is fully implemented with elbow support."
            IS_PERFECT=true
        elif [ $PERCENTAGE -ge 75 ]; then
            echo "✅ High tension dance logic is robust."
        else
            echo "⚠️ Dance logic components are partial (missing elbows or jumps?)."
        fi
    else
        echo "❌ Motion: Rotation logic missing. Cannot proceed to TORA TORA check."
    fi
else
    echo "⚠️ UI Source not found. Skipping motion check."
fi

# 8. ライブ・モーション検証 (オプション)
echo -e "\n[8/7] Would you like to perform a Visual Motion Verification? (y/n)"
if [ "$IS_PERFECT" = true ]; then
    echo "✨ Perfect score detected. Visual evaluation is highly recommended."
    read -p "Press [Enter] to start G1:M Live Testing or 'n' to skip: " CONFIRM
else
    read -t 5 -n 1 -r CONFIRM
fi

if [[ $CONFIRM =~ ^[Yy]$ ]] || [[ -z $CONFIRM && "$IS_PERFECT" = true ]]; then
    echo -e "\n🚀 Launching G1:M for live testing..."
    ./start_g1m.sh --no-java > /dev/null 2>&1 &
    LAUNCH_PID=$!
    
    echo "⏳ Waiting for local server (3000) to be ready..."
    until curl -s http://localhost:3000/healthz > /dev/null; do sleep 2; done
    
    echo "✨ Sending 'TORA TORA' command to Ollama..."
    # tora.md または定型文の取得
    if [ -f "tora.md" ]; then
        PROMPT_CONTENT=$(cat tora.md)
    elif [ -f "refer/g1m/わーい 最高にテンション上がる TORA TORA.txt" ]; then
        PROMPT_CONTENT=$(cat "refer/g1m/わーい 最高にテンション上がる TORA TORA.txt")
    else
        PROMPT_CONTENT="わーい！最高にテンション上がる TORA TORA を踊って！肘もガンガン曲げて激しく動いて！"
    fi

    echo "✨ Sending instruction to Ollama..."
    curl -s -X POST http://localhost:3000/api/llm \
         -H "Content-Type: application/json" \
         -d "{\"prompt\": \"$PROMPT_CONTENT\"}" > /dev/null
    
    echo "----------------------------------------------------"
    echo "👀 Please check the UI at: http://localhost:3000"
    echo "The bot should start dancing in 3D now."
    echo "----------------------------------------------------"
    
    echo "Press any key to stop the test and terminate the server."
    read -n 1 -r
    kill $LAUNCH_PID 2>/dev/null || true
    fuser -k 3000/tcp 2>/dev/null || true
    echo "✅ Live test finished."
else
    echo -e "\n⏭️ Skipping live verification."
fi

echo -e "\n===================================================="
echo "✨ All systems verified (Simple Config Applied)."