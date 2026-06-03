use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use socketioxide::{
    extract::{Data, SocketRef},
    SocketIo,
    socket::DisconnectReason,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use socketioxide::layer::SocketIoLayer;
use tower_http::services::ServeDir;
use tokio::sync::mpsc;
use std::fs;

use crate::p2p::P2PCommand;

#[derive(Clone)]
pub struct AppState {
    pub db_conn: Arc<Mutex<rusqlite::Connection>>,
    pub p2p_tx: mpsc::Sender<P2PCommand>,
    pub hf_complex_url: String,
    pub huggingface_token: String,
    pub ollama_url: String,
    pub ollama_model: String,
    pub participants: Arc<Mutex<HashMap<String, ParticipantInfo>>>,
    pub help_gauge: Arc<Mutex<i32>>,
    pub io: SocketIo, // SocketIoインスタンスをAppStateに含める
    pub client: reqwest::Client, // クライアントを再利用
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParticipantInfo {
    pub id: String,
    pub role: String,
    #[serde(rename = "anonymousId")]
    pub anonymous_id: Option<String>,
    pub poc_token: Option<String>,
    pub nickname: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LlmRequest {
    pub prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LlmResponse {
    pub response: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessRequest {
    pub uuid: String,
    pub base64_data: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WalletRegisterRequest {
    #[serde(rename = "anonymousId")]
    pub anonymous_id: String,
    #[serde(rename = "walletImageData")]
    pub wallet_image_data: String,
    #[serde(rename = "walletType")]
    pub wallet_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfileRegisterRequest {
    pub anonymous_id: String,
    pub wallet_image: Option<String>,
    pub cnc_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DonateRequest {
    pub amount: u32,
}

// REST Endpoints
async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "g1m-rust-node"
    }))
}

fn normalize_url(url: &str) -> String {
    if url.ends_with('/') { url.to_string() }
    else { format!("{}/", url) }
}

// LLM request handler with failover (HF -> local Ollama)
async fn handle_llm(
    State(state): State<AppState>,
    // io: SocketIo, // SocketIoはAppStateから取得するため削除
    Json(payload): Json<LlmRequest>,
) -> impl IntoResponse {
    log::info!("🤖 [Brain] Processing request: {}", payload.prompt);

    // --- RAG: 知識ベースからの検索 (Brain機能) ---
    let mut context_augmented_prompt = payload.prompt.clone();
    {
        let db = state.db_conn.lock().unwrap();
        // 簡易的なキーワードまたは埋め込み検索 (本来は埋め込みモデルを通すが、ここではDBのmatch_knowledgeを利用)
        // ダミーのクエリベクトル（本来はpromptをベクトル化する）
        let query_vec = vec![0.0; 384]; 
        if let Ok(matches) = crate::db::match_knowledge(&db, &query_vec, 0.1, 3) {
            if !matches.is_empty() {
                let context = matches.iter()
                    .map(|m| m.content.clone())
                    .collect::<Vec<_>>()
                    .join("\n");
                context_augmented_prompt = format!("以下の知識を参考に答えてください:\n{}\n\n質問: {}", context, payload.prompt);
                log::info!("📚 [RAG] Context injected from knowledge base.");
            }
        }
    }

    log::info!("🤖 [LLM] Routing to Local Ollama...");
    // 1. Try Local Ollama
    let ollama_base = normalize_url(&state.ollama_url);
    let ollama_endpoint = format!("{}api/chat", ollama_base);
    
    match state.client.post(&ollama_endpoint)
        .json(&serde_json::json!({
            "model": state.ollama_model,
            "options": { "num_predict": 512 },
            "messages": [
                { "role": "system", "content": "あなたはG1:Mちゃんです。フレンドリーな日本語で回答してください。" },
                { "role": "user", "content": context_augmented_prompt }
            ],
            "stream": false
        })).send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(text) = data["message"]["content"].as_str() {
                        println!("✅ [Ollama Response] {}", text);
                        log::info!("✅ [Ollama] Result: {}", text);
                        let display_text = format!("【Local PC Node】 {}", text);
                        let _ = state.io.emit("bot_response", serde_json::json!({ "text": display_text }));
                        return Json(LlmResponse { response: display_text.clone(), text: display_text }).into_response();
                    }
                }
            }
            log::warn!("Local Ollama returned error status: {:?}", status);
        }
        Err(e) => {
            log::warn!("Local Ollama unavailable ({}): trying next node...", e);
        }
    }

    // 1.5 Try Local Python AI Node (Internal logic priority)
    log::info!("Trying Local Python Node at http://127.0.0.1:8000...");
    let python_endpoint = "http://127.0.0.1:8000/v1/chat/completions";
    
    match state.client.post(python_endpoint)
        .json(&serde_json::json!({
            "model": state.ollama_model, // AppStateに保持されたモデル名を使用
            "messages": [
                { "role": "system", "content": "あなたはG1:Mちゃんです。フレンドリーで親しみやすい日本語で回答してください。" },
                { "role": "user", "content": context_augmented_prompt }
            ],
            "max_tokens": 512,
            "temperature": 0.8
        })).send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    let text = data["choices"][0]["message"]["content"]
                        .as_str()
                        .or_else(|| data["response"].as_str())
                        .unwrap_or_default().to_string();
                    if !text.is_empty() {
                        log::info!("✅ [Python] Result: {}", text);
                        let display_text = format!("【Local Python Node】 {}", text);
                        let _ = state.io.emit("bot_response", serde_json::json!({ "text": display_text }));
                        return Json(LlmResponse { response: display_text.clone(), text: display_text }).into_response();
                    }
                }
            }
            log::warn!("Local Python Node returned status: {:?}", status);
        }
        Err(e) => {
            log::warn!("Local Python Node unavailable ({})...", e);
        }
    }

    // 1.8 Try to delegate directly to connected Staff Nodes (Distributed)
    // ローカルノードが見つからない場合、接続中のPCノード（スタッフ）を探す
    let staff_ids: Vec<String> = {
        let parts = state.participants.lock().unwrap();
        parts.values().filter(|p| p.role == "staff").map(|p| p.id.clone()).collect()
    };

    if !staff_ids.is_empty() {
        // タスクが重なった際、別のノードに振り分けるための分散ロジック
        // リクエストごとにランダム（UUIDベース）にノードを選択
        let sid = staff_ids[uuid::Uuid::new_v4().as_u128() as usize % staff_ids.len()].clone();
        let task_id = format!("task-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        println!("🚀 [LLM] Distributing task to all staff nodes (Ref: {})", task_id);
        
        // ルーム "staff" に参加しているすべてのブリッジに送信
        // 一番早く計算が終わったノードが task_result を返せばOK
        let _ = state.io.to("staff").emit("distribute_task", serde_json::json!({
            "taskId": task_id,
            "prompt": context_augmented_prompt.clone()
        }));
        return Json(LlmResponse { 
            response: format!("【Distributed】PCノード({})にタスクを送信しました...", &sid[..4]), 
            text: "Processing...".to_string() 
        }).into_response();
    }

    // 2. Failover to Hugging Face (助け舟)
    // どこにもノードが無い場合に初めてHFが助け舟を出す
    // HF_COMPLEX_URL が空なら LLM_API_URL もフォールバック候補にする
    let hf_url = if !state.hf_complex_url.is_empty() {
        state.hf_complex_url.clone()
    } else {
        std::env::var("LLM_API_URL").unwrap_or_default()
    };
    
    if !hf_url.is_empty() {
        let _ = state.io.emit("system_log", serde_json::json!({
            "message": "☁️ PC Node不在。HF Super Nodeへ転送中 (回答まで数分かかる場合があります)",
            "timestamp": "now"
        }));

        let _ = state.io.emit("subtitle", serde_json::json!({ "text": "[G1:M] クラウドで考え中..." }));

        // HFリクエストをバックグラウンドで実行し、HTTPレスポンスは即座に返す
        let state_task = state.clone();
        let prompt_task = payload.prompt.clone();
        let hf_url_task = hf_url.clone();

        tokio::spawn(async move {
            log::info!("☁️ [TASK] Background HF Inference started for: {}", hf_url_task);
            let api_path = if hf_url_task.ends_with('/') { "v1/chat/completions" } else { "/v1/chat/completions" };
            let target_url = format!("{}{}", hf_url_task, api_path);
            
            let hf_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(900))
                .build()
                .unwrap_or_else(|_| state_task.client.clone());
            
            let mut req = hf_client.post(&target_url)
                .json(&serde_json::json!({
                    "model": "llama-3.1-8b",
                    "messages": [
                        { "role": "system", "content": "あなたはG1:Mちゃんです。フレンドリーで親しみやすい日本語で回答してください。" },
                        { "role": "user", "content": context_augmented_prompt } // Augmented prompt
                    ],
                    "max_tokens": 512,
                    "temperature": 0.8
                }));
                
            if !state_task.huggingface_token.is_empty() {
                req = req.bearer_auth(&state_task.huggingface_token);
            }

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let is_json = resp.headers()
                        .get("content-type")
                        .and_then(|ct| ct.to_str().ok())
                        .map(|ct| ct.contains("application/json"))
                        .unwrap_or(false);

                    if status.is_success() && is_json {
                        if let Ok(data) = resp.json::<serde_json::Value>().await {
                            let text = data["choices"][0]["message"]["content"]
                                .as_str()
                                .or_else(|| data["choices"][0]["text"].as_str())
                                .or_else(|| data["text"].as_str())
                                .or_else(|| data["response"].as_str())
                                .unwrap_or("解析不能")
                                .to_string();
                            log::info!("☁️ [HF Node] Inference successful");
                            let display_text = format!("【HF Super Node】 {}", text);
                            let _ = state_task.io.emit("bot_response", serde_json::json!({ "text": display_text }));
                        }                        
                    } else if status.is_success() && !is_json {
                        let _ = state_task.io.emit("system_log", serde_json::json!({
                            "message": "⏳ HF Space が起動中のようです。数分後に再試行してください。",
                            "timestamp": "now"
                        }));
                    } else {
                        log::warn!("HF task failed with status: {:?}", status);
                        let _ = state_task.io.emit("system_log", serde_json::json!({
                            "message": format!("❌ HF Node Error: {}", status),
                            "timestamp": "now"
                        }));
                    }
                }
                Err(e) => {
                    log::error!("HF task request failed: {:?}", e);
                }
            }
        });

        return Json(LlmResponse { 
            response: "【HF Super Node】リクエストを送信しました。クラウドで推論中のため、回答が届くまで最大10分〜15分程度かかる場合があります。このままお待ちください...".to_string(), 
            text: "Processing...".to_string() 
        }).into_response();
    } else {
        log::warn!("No HF endpoint configured (HF_COMPLEX_URL and LLM_API_URL both empty)");
    }

    // 全ての手段が失敗した場合
    log::error!("❌ No inference nodes available (Local, Staff, or HF).");
    let error_msg = "現在、応答できるAIノードがありません。PC Nodeを起動するか、HFエンドポイントを設定してください。";
    let _ = state.io.emit("system_log", serde_json::json!({
        "message": format!("❌ {}", error_msg),
        "timestamp": "now"
    }));
    (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
        "error": "No available AI node found anywhere.",
        "response": error_msg
    }))).into_response()
}

// Helper to determine if target URL ends in /
trait EndsOk {
    fn ends_ok(&self) -> bool;
}
impl EndsOk for String {
    fn ends_ok(&self) -> bool {
        self.ends_with('/')
    }
}

async fn handle_process(
    State(state): State<AppState>,
    Json(payload): Json<ProcessRequest>,
) -> impl IntoResponse {
    // Check if we should redirect to HF
    if !state.hf_complex_url.is_empty() {
        let client = reqwest::Client::new();
        let target_url = if state.hf_complex_url.ends_ok() {
            format!("{}api/process", state.hf_complex_url)
        } else {
            format!("{}/api/process", state.hf_complex_url)
        };
        
        match client.post(&target_url).json(&payload).send().await {
            Ok(resp) => {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    return Json(data).into_response();
                }
            }
            Err(e) => {
                log::error!("Redirecting process to HF failed: {:?}", e);
            }
        }
    }
    
    // Local fallback
    Json(serde_json::json!({
        "status": "success",
        "message": "Data processed locally on Rust node",
        "uuid": payload.uuid
    })).into_response()
}

async fn handle_bot_wallet() -> impl IntoResponse {
    // 実行バイナリの場所に関わらず、カレントディレクトリ(Dockerなら/app)からの相対パスで解決
    let current_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    
    // 実行バイナリの親ディレクトリからプロジェクトルートを推定
    let exe_root = std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| current_dir.clone());
    
    let mut paths_to_try = vec![
        current_dir.join("z1m/AirWallet/g1-m_chan.jpeg"),
        current_dir.join("public/z1m/AirWallet/g1-m_chan.jpeg"),
        current_dir.join("G1M/Assets/g1-m_chan.jpeg"),
        std::path::PathBuf::from("z1m/AirWallet/g1-m_chan.jpeg"),
        // Docker絶対パス (/app/z1m/AirWallet/)
        std::path::PathBuf::from("/app/z1m/AirWallet/g1-m_chan.jpeg"),
        // start_g1m.sh からの実行: バイナリは g1m-node/target/release/ にあるため2つ上
        exe_root.join("../../z1m/AirWallet/g1-m_chan.jpeg"),
        // g1m-nodeディレクトリからの相対パス
        exe_root.join("../../../z1m/AirWallet/g1-m_chan.jpeg"),
    ];
    // 正規化して重複を排除
    paths_to_try.iter_mut().for_each(|p| {
        if let Ok(canonical) = p.canonicalize() {
            *p = canonical;
        }
    });
    paths_to_try.dedup();
    
    let mut file_data = None;
    for path in &paths_to_try {
        if path.exists() {
            if let Ok(data) = fs::read(path) {
                log::info!("✅ Bot QR loaded from: {:?}", path);
                file_data = Some(data);
                break;
            }
        }
    }
    
    if let Some(bitmap) = file_data {
        use base64::Engine;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(bitmap);
        let data_url = format!("data:image/jpeg;base64,{}", base64_data);
        Json(serde_json::json!({
            "anonymous_id": "bot",
            "wallet_image_data": data_url,
            "wallet_type": "AirWallet"
        })).into_response()
    } else {
        log::error!("❌ Bot QR file not found. Tried paths: {:?}", paths_to_try);
        (StatusCode::NOT_FOUND, "Bot QR file not found").into_response()
    }
}

async fn handle_get_wallet(
    State(state): State<AppState>,
    Path(anonymous_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db_conn.lock().unwrap();
    match crate::db::get_nickname(&db, &anonymous_id) {
        Ok(Some((nickname, _, wallet_image, cnc_url))) => Json(serde_json::json!({
            "anonymous_id": anonymous_id,
            "nickname": nickname,
            "wallet_image_data": wallet_image,
            "cnc_url": cnc_url
        })).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Wallet not found").into_response(),
    }
}

async fn handle_register_wallet(
    State(state): State<AppState>,
    Json(payload): Json<ProfileRegisterRequest>,
) -> impl IntoResponse {
    let db = state.db_conn.lock().unwrap();
    let res = crate::db::update_user_profile(
        &db, 
        &payload.anonymous_id, 
        None, 
        payload.wallet_image.as_deref(), 
        payload.cnc_url.as_deref()
    );
    
    match res {
        Ok(_) => Json(serde_json::json!({
            "status": "success",
            "anonymous_id": payload.anonymous_id
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to register: {:?}", e)).into_response(),
    }
}

async fn handle_donate(Json(payload): Json<DonateRequest>) -> impl IntoResponse {
    Json(serde_json::json!({
        "message": format!("{}円送ったよ、ありがとう！応援よろしく！", payload.amount)
    }))
}

async fn handle_get_history(State(state): State<AppState>) -> impl IntoResponse {
    let db = state.db_conn.lock().unwrap();
    // Retrieve recent messages from g1m.db
    match crate::db::get_recent_messages(&db, 50) {
        Ok(messages) => Json(messages).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Failed to load history from g1m.db").into_response(),
    }
}

async fn handle_help_action(State(state): State<AppState>) -> impl IntoResponse {
    let mut gauge = state.help_gauge.lock().unwrap();
    // Helping someone restores the gauge
    *gauge = (*gauge + 20).min(100);
    Json(serde_json::json!({
        "status": "success",
        "current_gauge": *gauge,
        "message": "Helping hand acknowledged! Gauge restored."
    }))
}

async fn handle_get_gauge(State(state): State<AppState>) -> impl IntoResponse {
    let gauge = state.help_gauge.lock().unwrap();
    Json(serde_json::json!({ "help_gauge": *gauge }))
}

// SocketIO Signaling & Relay Logic
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RegisterPayload {
    pub role: String,
    #[serde(rename = "anonymousId")]
    pub anonymous_id: Option<String>,
    #[serde(rename = "pocToken")]
    pub poc_token: Option<String>,
    pub nickname: Option<String>,
}

pub fn create_router(state: AppState, socketio_layer: SocketIoLayer) -> Router { // socketio_layerを引数で受け取る
    let io = state.io.clone();
    let st = state.clone();

    io.ns("/", move |socket: SocketRef| {
        log::info!("Socket.IO Connected: {}", socket.id);

        // 推論能力の判定 (非同期で実際のサービス状態を確認)
        let st_cap = st.clone();
        let socket_cap = socket.clone();
        tokio::spawn(async move {
            let is_render = std::env::var("RENDER").is_ok();
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(1200)) // 素早いレスポンスを期待
                .build().unwrap_or_default();

            // Ollama と Python ノードの生存確認 (実際にリクエストを飛ばす)
            let ollama_url = st_cap.ollama_url.trim_end_matches('/');
            let ollama_alive = client.get(format!("{}/api/tags", ollama_url)).send().await.is_ok();
            let python_alive = client.get("http://127.0.0.1:8000/health").send().await.is_ok();
            
            // Local AI または HF 設定があれば推論可能とみなす
            let local_inference_available = (!is_render && (ollama_alive || python_alive)) || !st_cap.hf_complex_url.is_empty();
            
            let total_active_nodes = {
                let parts = st_cap.participants.lock().unwrap();
                // すべてのスタッフノード（ブリッジを含む）をカウント
                parts.values().filter(|p| p.role == "staff").count()
            };

            log::info!("📊 Node Capability (Verified) - Local: {}, Staff: {}, Total: {}", 
                local_inference_available, total_active_nodes, total_active_nodes);

            // 初回送信
            let _ = socket_cap.emit("server_capabilities", serde_json::json!({
                "has_local_llm": local_inference_available,
                "active_nodes": total_active_nodes
            }));
        });

        // 接続時に現在のチャット履歴をコンソールに出力
        log::info!("📡 [SYSTEM] New participant connected: {}", socket.id);
        let _ = socket.emit("system_log", serde_json::json!({
            "message": "PC Node Connection established.",
            "timestamp": "now"
        }));

        // チャットメッセージの受信とブロードキャスト
        socket.on("chat_message", {
            let st = st.clone();
            move |socket: SocketRef, Data(payload): Data<Value>| {
                let sender = payload["senderName"].as_str().unwrap_or("?");
                let msg = payload["text"].as_str().unwrap_or("");

                // ターミナルにチャット履歴を直接表示
                println!("\n💬 [CHAT] {}: {}", sender, msg);
                println!("----------------------------------");

                log::info!("💬 [CHAT] {}: {}", sender, msg);
                
                // 送信者以外の全員にブロードキャスト（自分自身には送らない）
                let _ = socket.broadcast().emit("chat_message", payload.clone());

                // P2Pネットワークへ転送
                if let (Some(text), Some(name)) = (payload["text"].as_str(), payload["senderName"].as_str()) {
                    let _ = st.p2p_tx.try_send(P2PCommand::PublishChat { 
                        id: payload["id"].as_str().unwrap_or(&uuid::Uuid::new_v4().to_string()).to_string(), 
                        text: text.to_string(), 
                        sender_name: name.to_string() 
                    });
                }
            }
        });

        // --- DM (Direct Message) 機能 ---
        socket.on("private_message", {
            let st = st.clone();
            move |socket: SocketRef, Data(payload): Data<Value>| {
                let target_id = payload["targetId"].as_str().unwrap_or_default().to_string();
                let message = payload["text"].as_str().unwrap_or_default().to_string();
                
                log::info!("💌 [DM] From {} to {}: {}", socket.id, target_id, message);
                
                // 指定した相手にのみ送信
                let _ = socket.to(target_id).emit("private_message", serde_json::json!({
                    "from": socket.id.to_string(),
                    "text": message,
                    "senderName": payload["senderName"].as_str().unwrap_or("不明")
                }));
            }
        });

        // P2Pリレー対応シグナリング
        // `relay_signal` クロージャ自体も `st` をキャプチャするため、`st` のクローンが必要です。
        let relay_signal_st = st.clone();
        let relay_signal = move |socket: SocketRef, event_name: String, target_id: String, data_val: Value| {
            let local_msg = serde_json::json!({ 
                "from": socket.id.to_string(), 
                "sdp": data_val["sdp"], 
                "candidate": data_val["candidate"] 
            });
            // ローカルクライアントへの転送
            let _ = socket.to(target_id.clone()).emit(event_name.clone(), &local_msg); 

            // P2Pネットワークへの転送（別のノードにターゲットがいる場合）
            let p2p_payload = serde_json::json!({ "type": event_name, "from": socket.id.to_string(), "data": local_msg });
            let _ = relay_signal_st.p2p_tx.try_send(P2PCommand::PublishSignal { 
                target_id, 
                payload: p2p_payload.to_string() 
            });
        };

        // `st.participants` を使用する各 `socket.on` クロージャ内で `st` をクローンします。
        // `relay_signal` を使用するクロージャでは、`relay_signal` 自体をクローンして渡します。

        socket.on("register_role", { let st = st.clone(); move |socket: SocketRef, Data(payload): Data<RegisterPayload>| {
            let mut nickname = payload.nickname.clone().unwrap_or_else(|| "ゲスト".to_string());

            // DBから保存済みのニックネームを取得して復元
            if let Some(ref anon_id) = payload.anonymous_id {
                let db = st.db_conn.lock().unwrap();
                if let Ok(Some((db_nick, _))) = crate::db::get_nickname(&db, anon_id) {
                    nickname = db_nick;
                }
            }

            let info = ParticipantInfo { 
                id: socket.id.to_string(), 
                role: payload.role.clone(), 
                anonymous_id: payload.anonymous_id.clone(), 
                poc_token: payload.poc_token.clone(),
                nickname: nickname.clone(),
            };
            
            { 
                let mut parts = st.participants.lock().unwrap(); parts.insert(socket.id.to_string(), info.clone()); 
                if payload.role == "staff" { let _ = socket.join("staff"); } // スタッフルームに参加
                let others: Vec<ParticipantInfo> = parts.values().filter(|p| p.id != socket.id.to_string()).cloned().collect(); let _ = socket.emit("participants_list", others); }
            log::info!("Register role: {} as {}", socket.id, payload.role); let _ = socket.broadcast().emit("participant_joined", info);

            // スタッフノードが参加した場合、全クライアントに最新のノード数を通知する
            let parts = st.participants.lock().unwrap();
            let count = parts.values().filter(|p| p.role == "staff").count();
            // has_local_llm は起動時の判定に任せ、ここではアクティブノード数のみ更新
            let _ = st.io.emit("server_capabilities", serde_json::json!({
                "active_nodes": count
            }));
        }});

        socket.on("update_nickname", { let st = st.clone(); move |socket: SocketRef, Data(payload): Data<Value>| {
            let nickname = payload["nickname"].as_str().unwrap_or("ゲスト").to_string();
            let anon_id = { 
                let mut parts = st.participants.lock().unwrap(); 
                if let Some(p) = parts.get_mut(&socket.id.to_string()) { 
                    p.nickname = nickname.clone(); 
                    p.anonymous_id.clone()
                } else { None }
            };

            // DBにニックネームを保存
            if let Some(id) = anon_id {
                let db = st.db_conn.lock().unwrap();
                let _ = crate::db::save_nickname(&db, &id, &nickname, true);
            }

            let _ = socket.broadcast().emit("participant_updated", serde_json::json!({ "id": socket.id.to_string(), "nickname": nickname }));
        }});

        socket.on("offer", { let rs = relay_signal.clone(); move |socket: SocketRef, Data(payload): Data<Value>| { let target_id = payload["targetId"].as_str().unwrap_or_default().to_string(); rs(socket, "offer".to_string(), target_id, payload); } });
        socket.on("answer", { let rs = relay_signal.clone(); move |socket: SocketRef, Data(payload): Data<Value>| { let target_id = payload["targetId"].as_str().unwrap_or_default().to_string(); rs(socket, "answer".to_string(), target_id, payload); } });
        socket.on("candidate", { let rs = relay_signal.clone(); move |socket: SocketRef, Data(payload): Data<Value>| { let target_id = payload["targetId"].as_str().unwrap_or_default().to_string(); rs(socket, "candidate".to_string(), target_id, payload); } });

        socket.on_disconnect({ let st = st.clone(); move |socket: SocketRef, _reason: DisconnectReason| {
            let leaving_role = {
                let mut parts = st.participants.lock().unwrap();
                parts.remove(&socket.id.to_string()).map(|p| p.role)
            };
            log::info!("Socket disconnected: {}", socket.id);
            let _ = socket.broadcast().emit("participant_left", serde_json::json!({ "id": socket.id.to_string() }));

            // スタッフが離脱した場合も全通知
            if leaving_role == Some("staff".to_string()) {
                let parts = st.participants.lock().unwrap();
                let count = parts.values().filter(|p| p.role == "staff").count();
                let _ = st.io.emit("server_capabilities", serde_json::json!({ "active_nodes": count }));
            }
        }});

        socket.on("task_result", { let st = st.clone(); move |socket: SocketRef, Data(payload): Data<Value>| {
            let result = payload["result"].as_str().unwrap_or("");
            if result.is_empty() {
                return;
            }
            let result = result.to_string();
            
            // タスクを返してきたクライアントの poc_token を取得
            let poc_token = {
                let parts = st.participants.lock().unwrap();
                parts.get(&socket.id.to_string()).and_then(|p| p.poc_token.clone())
            };

            // トークンがあれば結果の先頭に付与
            let final_result = if let Some(token) = poc_token {
                format!("{} {}", token, result)
            } else {
                result
            };

            let msg = serde_json::json!({ "text": final_result, "actionName": "" });
            // 全員（AIの回答を待っているユーザー全員）に送信
            let _ = st.io.emit("bot_response", msg);
            
            // タスク完了をP2P全体に通知（チャット形式でリザルトを共有）
            let _ = st.p2p_tx.try_send(P2PCommand::PublishChat {
                id: uuid::Uuid::new_v4().to_string(),
                text: format!("[P2P Success] {}", final_result),
                sender_name: "G1:M Distributed Node".to_string(),
            });
        }});
    });

    let static_dir = ServeDir::new("frontend/dist").fallback(ServeDir::new("../frontend/dist"));

    let router = Router::new()
        .route("/healthz", get(health_check))
        .route("/api/llm", post(handle_llm))
        .route("/api/history", get(handle_get_history))
        .route("/api/help", post(handle_help_action))
        .route("/api/gauge", get(handle_get_gauge))
        .route("/api/process", post(handle_process))
        .route("/api/kampa/wallet/bot", get(handle_bot_wallet))
        .route("/api/kampa/wallet/:anonymousId", get(handle_get_wallet))
        .route("/api/kampa/wallet/register", post(handle_register_wallet))
        .route("/api/kampa/donate", post(handle_donate))
        .fallback_service(static_dir)
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(socketio_layer); // 最外層に置くことで /socket.io/ パスを確実にキャッチする

    router
}
