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
use std::collections::{HashMap, HashSet};
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

#[allow(dead_code)]
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

    // 1. まずローカルのOllamaを試みる (Local-First 優先)
    // 自前で推論できる場合は、外部のスタッフノードやブリッジを経由せず直接処理するのが最も効率的です。
    // ブリッジ経由のタスク分配は、ローカル推論が失敗するか、他のPCを協力させる場合に使用します。
    if !state.ollama_url.is_empty() {
        log::info!("🤖 [LLM] Trying Local Ollama first...");
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
    }

    // 2. ローカルOllama失敗時 → 接続中のstaffノード（他PCのBridge）へ委譲
    let staff_nodes: Vec<(String, String)> = {
        let mut parts = state.participants.lock().unwrap();
        let active_sockets = state.io.sockets().unwrap_or_default();
        let active_ids: HashSet<String> = active_sockets.into_iter().map(|s| s.id.to_string()).collect();
        
        // 配信直前にゾンビを掃除し、確実に生きている接続のみを抽出
        parts.retain(|id, _| active_ids.contains(id));

        parts.iter()
            .filter(|(_, p)| p.role == "staff" && p.poc_token.as_deref().map_or(false, |t| t.contains("[PC-")))
            .map(|(id, p)| (id.clone(), p.poc_token.clone().unwrap_or_default()))
            .collect()
    };

    if !staff_nodes.is_empty() {
        let (sid, token) = staff_nodes[uuid::Uuid::new_v4().as_u128() as usize % staff_nodes.len()].clone();
        let task_id = format!("task-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        log::info!("🚀 [LLM] Distributing task to PC Bridge: {} (Token: {}, TaskID: {})", sid, token, task_id);
        
        // 特定のソケット（ルームID=SID）へ直接配信
        // Render環境での到達性を高めるため、名前空間を明示
        let _ = state.io.of("/").unwrap().to(sid.clone()).emit("distribute_task", serde_json::json!({
            "taskId": task_id,
            "prompt": context_augmented_prompt.clone()
        }));
        return Json(LlmResponse { 
            response: format!("【Distributed】PCノード({})にタスクを送信しました...", &sid[..4.min(sid.len())]), 
            text: "Processing...".to_string() 
        }).into_response();
    }

    // 3. ローカルPython AIノードを試みる
    log::info!("Trying Local Python Node at http://127.0.0.1:8000...");
    let python_endpoint = "http://127.0.0.1:8000/v1/chat/completions";
    
    match state.client.post(python_endpoint)
        .json(&serde_json::json!({
            "model": state.ollama_model,
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
        let hf_url_task = hf_url.clone();

        tokio::spawn(async move {
            log::info!("☁️ [TASK] Background HF Inference started for: {}", hf_url_task);
            let api_path = if hf_url_task.ends_with('/') { "v1/chat/completions" } else { "/v1/chat/completions" };
            let target_url = format!("{}{}", hf_url_task, api_path);
            let hf_client = state_task.client.clone();
            
            let mut req = hf_client.post(&target_url)
                .json(&serde_json::json!({
                    "model": state_task.ollama_model, // 環境変数で指定されたモデル名を使用
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
                            log::info!("✅ ☁️ [HF Node] Inference successful: {}...", text.chars().take(20).collect::<String>());
                            let display_text = format!("【HF Super Node】 {}", text);
                            let _ = state_task.io.emit("bot_response", serde_json::json!({ "text": display_text }));
                        }                        
                    } else if status.is_success() && !is_json {
                        log::warn!("☁️ [HF Node] Space is starting/warming up...");
                        let _ = state_task.io.emit("bot_response", serde_json::json!({
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
            response: "【HF Super Node】リクエストを送信しました。クラウド推論完了までこのままお待ちください...".to_string(), 
            text: "Status: Connecting to Cloud...".to_string() 
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
    
    let bot_id = "g1m";
    let bot_cnc = format!("https://cnc-pwa.onrender.com/?id={}", bot_id);
    
    let mut paths_to_try = vec![
        current_dir.join("z1m/AirWallet/g1-m_chan.jpeg"),
        current_dir.join("z1m/AirWallet/g1-m_chan.jpeg"),
        current_dir.join("public/z1m/AirWallet/g1-m_chan.jpeg"),
        current_dir.join("G1M/Assets/g1-m_chan.jpeg"),
        // Docker絶対パス (/app/z1m/AirWallet/)
        std::path::PathBuf::from("/app/z1m/AirWallet/g1-m_chan.jpeg"),
        // 各プロジェクト構成に対応する相対パス
        exe_root.join("../../z1m/AirWallet/g1-m_chan.jpeg"),    // target/release/ からの相対
        exe_root.join("../../../z1m/AirWallet/g1-m_chan.jpeg"), // g1m-node/ からの相対
    ];
    // 正規化して重複を排除
    paths_to_try.iter_mut().for_each(|p| {
        if let Ok(canonical) = p.canonicalize() {
            *p = canonical;
        }
    });
    paths_to_try.sort(); paths_to_try.dedup();
    
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
            "anonymous_id": bot_id,
            "wallet_image_data": data_url,
            "wallet_type": "AirWallet",
            "cnc_url": bot_cnc
        })).into_response()
    } else {
        log::error!("❌ Bot QR file not found. Tried paths: {:?}", paths_to_try);
        (StatusCode::OK, Json(serde_json::json!({
            "anonymous_id": bot_id,
            "wallet_image_data": null,
            "cnc_url": bot_cnc
        }))).into_response()
    }
}

async fn handle_get_wallet(
    State(state): State<AppState>,
    Path(anonymous_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db_conn.lock().unwrap();
    match crate::db::get_nickname(&db, &anonymous_id) {
        Ok(Some((nickname, _, wallet_image, cnc_url, email, notify))) => (StatusCode::OK, Json(serde_json::json!({
            "anonymous_id": anonymous_id,
            "nickname": nickname,
            "wallet_image_data": wallet_image,
            "cnc_url": cnc_url,
            "email": email,
            "notification_enabled": notify
        }))).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "Wallet not found").into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response(),
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
        payload.cnc_url.as_deref(),
        None,
        None
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

        // 能力チェックと通知を行う共通ロジック
        let emit_capabilities = |st: AppState, target: Option<SocketRef>| {
            tokio::spawn(async move {
                let (pc_nodes, hf_active) = {
                    let active_sockets = st.io.sockets().unwrap_or_default();
                    let active_ids: HashSet<String> = active_sockets.into_iter().map(|s| s.id.to_string()).collect();
                    let mut parts = st.participants.lock().unwrap();
                    parts.retain(|id, _| active_ids.contains(id));
                    
                    // [PC-...] トークンを持つものだけを PC Node としてカウント
                    let pc_count = parts.values().filter(|p| p.role == "staff" && p.poc_token.as_deref().map_or(false, |t| t.contains("[PC-"))).count();
                    // 【HF Super Node】トークンを持つか、設定URLがある場合に HF Active とする
                    let hf_node_active = parts.values().any(|p| p.role == "staff" && p.poc_token.as_deref() == Some("【HF Super Node】"));
                    (pc_count, hf_node_active)
                };

                let hf_available = hf_active || !st.hf_complex_url.is_empty();

                let payload = serde_json::json!({
                    "has_local_ai": pc_nodes > 0, // UIの PC NODE 表示に連動
                    "has_hf": hf_available,
                    "active_nodes": pc_nodes
                });

                if let Some(s) = target {
                    let _ = s.emit("server_capabilities", payload);
                } else {
                    let _ = st.io.emit("server_capabilities", payload);
                }
            });
        };

        // 接続直後のチェック
        emit_capabilities(st.clone(), Some(socket.clone()));

        // 手動同期リクエストへの対応
        socket.on("request_participants", { let st = st.clone(); let emit_cap = emit_capabilities.clone(); move |socket: SocketRef| {
            // 同期リクエスト時にも能力を再送
            emit_cap(st.clone(), Some(socket.clone()));
            
            let mut parts = st.participants.lock().unwrap();
            // ゾンビ対策: 同期リクエスト時にも実体を確認
            let active_sockets = st.io.sockets().unwrap_or_default();
            let active_ids: HashSet<String> = active_sockets.into_iter().map(|s| s.id.to_string()).collect();
            parts.retain(|id, _| active_ids.contains(id));
            let others: Vec<ParticipantInfo> = parts.values().filter(|p| p.id != socket.id.to_string()).cloned().collect();
            let _ = socket.emit("participants_list", others);
        }});

        socket.on("request_capabilities", { let st = st.clone(); let emit_cap = emit_capabilities.clone(); move |socket: SocketRef| {
            emit_cap(st.clone(), Some(socket));
        }});

        // ブリッジからの生存確認（ハートビート）
        socket.on("bridge_ping", move |socket: SocketRef, Data(payload): Data<Value>| {
            let _ = socket.emit("bridge_pong", payload);
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
        socket.on("private_message", move |socket: SocketRef, Data(payload): Data<Value>| {
            let target_id = payload["targetId"].as_str().unwrap_or_default().to_string();
            let message = payload["text"].as_str().unwrap_or_default().to_string();
            
            log::info!("💌 [DM] From {} to {}: {}", socket.id, target_id, message);
            
            // 指定した相手にのみ送信
            let _ = socket.to(target_id).emit("private_message", serde_json::json!({
                "from": socket.id.to_string(),
                "text": message,
                "senderName": payload["senderName"].as_str().unwrap_or("不明")
            }));
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

        socket.on("register_role", { let st = st.clone(); let emit_cap = emit_capabilities.clone(); move |socket: SocketRef, Data(payload): Data<RegisterPayload>| {
            let mut nickname = payload.nickname.clone().unwrap_or_else(|| "ゲスト".to_string());

            // DBから保存済みのニックネームを取得して復元
            if let Some(ref anon_id) = payload.anonymous_id {
                let db = st.db_conn.lock().unwrap();
                if let Ok(Some((db_nick, _, _, _, _, _))) = crate::db::get_nickname(&db, anon_id) {
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
                let mut parts = st.participants.lock().unwrap();
                // ゾンビ対策: 新規登録時にも無効なIDを掃除
                let active_sockets = st.io.sockets().unwrap_or_default();
                let active_ids: HashSet<String> = active_sockets.into_iter().map(|s| s.id.to_string()).collect();
                parts.retain(|id, _| active_ids.contains(id));
                parts.insert(socket.id.to_string(), info.clone()); 
                if payload.role == "staff" { let _ = socket.join("staff"); } // スタッフルームに参加
                let others: Vec<ParticipantInfo> = parts.values().filter(|p| p.id != socket.id.to_string()).cloned().collect(); let _ = socket.emit("participants_list", others); }
            
            log::info!("Register role: {} as {} (Token: {:?})", socket.id, payload.role, payload.poc_token); 
            let _ = socket.broadcast().emit("participant_joined", info);
            emit_cap(st.clone(), None); // 全員に正確な能力情報を再送
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

        socket.on_disconnect({ let st = st.clone(); let emit_cap = emit_capabilities.clone(); move |socket: SocketRef, _reason: DisconnectReason| {
            let _leaving_role = {
                let mut parts = st.participants.lock().unwrap();
                parts.remove(&socket.id.to_string()).map(|p| p.role)
            };
            log::info!("Socket disconnected: {}", socket.id);
            let _ = socket.broadcast().emit("participant_left", serde_json::json!({ "id": socket.id.to_string() }));
            emit_cap(st.clone(), None);
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
