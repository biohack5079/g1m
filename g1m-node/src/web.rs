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
use std::path::PathBuf;
use std::fs;

use crate::p2p::P2PCommand;

#[derive(Clone)]
pub struct AppState {
    pub db_conn: Arc<Mutex<rusqlite::Connection>>,
    pub p2p_tx: mpsc::Sender<P2PCommand>,
    pub hf_complex_url: String,
    pub huggingface_token: String,
    pub ollama_url: String,
    pub participants: Arc<Mutex<HashMap<String, ParticipantInfo>>>,
    pub help_gauge: Arc<Mutex<i32>>,
    pub io: SocketIo, // SocketIoインスタンスをAppStateに含める
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParticipantInfo {
    pub id: String,
    pub role: String,
    #[serde(rename = "anonymousId")]
    pub anonymous_id: Option<String>,
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

// LLM request handler with failover (HF -> local Ollama)
async fn handle_llm(
    State(state): State<AppState>,
    // io: SocketIo, // SocketIoはAppStateから取得するため削除
    Json(payload): Json<LlmRequest>,
) -> impl IntoResponse {
    // タイムアウトを設けない設定でクライアントを生成
    let client = reqwest::Client::builder().build().unwrap();
    
    // 1. Try Local Ollama First
    let ollama_url = state.ollama_url.replace("localhost", "127.0.0.1");
    log::info!("Trying Local Ollama at {}...", ollama_url);
    let ollama_endpoint = format!("{}/api/chat", ollama_url);
    let req = client.post(&ollama_endpoint)
        .json(&serde_json::json!({
            "model": "gemma3:4b-it-q4_K_M",
            "messages": [
                { "role": "system", "content": "あなたはG1:Mちゃんです。フレンドリーで親しみやすい日本語で回答してください。" },
                { "role": "user", "content": payload.prompt }
            ],
            "stream": false
        }));
        
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    let mut text = data["message"]["content"]
                        .as_str()
                        .unwrap_or("回答を生成できませんでした。")
                        .to_string();
                    text = format!("【Local Node】 {}", text);
                    
                    // AIの回答を全クライアントにブロードキャスト
                    let _ = state.io.emit("bot_response", serde_json::json!({ "text": text, "actionName": "" }));

                    // ローカル成功時は即座にリターン（排他）
                    return Json(LlmResponse { response: text.clone(), text }).into_response();
                }
            }
        }
        Err(e) => {
            log::warn!("Local Ollama query failed: {:?}", e);
        }
    }

    // 1.5 Try Local Python AI Node (Internal logic priority)
    log::info!("Trying Local Python Node at http://127.0.0.1:8000...");
    let python_endpoint = "http://127.0.0.1:8000/v1/chat/completions";
    let req = client.post(python_endpoint)
        .json(&serde_json::json!({
            "model": "google_gemma-3-4b-it",
            "messages": [
                { "role": "system", "content": "あなたはG1:Mちゃんです。フレンドリーで親しみやすい日本語で回答してください。" },
                { "role": "user", "content": payload.prompt }
            ],
            "max_tokens": 512,
            "temperature": 0.8
        }));

    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    let mut text = data["choices"][0]["message"]["content"]
                        .as_str()
                        .or_else(|| data["response"].as_str())
                        .unwrap_or("回答を生成できませんでした。")
                        .to_string();
                    text = format!("【Local AI】 {}", text);
                    
                    // AIの回答を全クライアントにブロードキャスト
                    let _ = state.io.emit("bot_response", serde_json::json!({ "text": text, "actionName": "" }));

                    // ローカル成功時は即座にリターン（排他）
                    // ローカルAIが応答を返したら、ここで終了（HFには行かない）
                    return Json(LlmResponse { response: text.clone(), text }).into_response();
                }
            }
            log::warn!("Local Python Node returned status: {:?}", status);
        }
        Err(e) => {
            log::warn!("Local Python Node query failed: {:?}", e);
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
        log::info!(">>> [Inference] Delegating task to Staff Node: {}", sid);
        let _ = state.io.to(sid.clone()).emit("distribute_task", serde_json::json!({
            "taskId": uuid::Uuid::new_v4().to_string(),
            "prompt": payload.prompt.clone()
        }));
        return Json(LlmResponse { 
            response: format!("【Distributed】PCノード({})にタスクを送信しました...", &sid[..4]), 
            text: "Processing...".to_string() 
        }).into_response();
    }

    // 2. Failover to Hugging Face (助け舟)
    // どこにもノードが無い場合に初めてHFが助け舟を出す
    if !state.hf_complex_url.is_empty() {
        log::info!("Falling back to Hugging Face LLM endpoint...");
        let api_path = if state.hf_complex_url.ends_with('/') {
            "v1/chat/completions"
        } else {
            "/v1/chat/completions"
        };
        let target_url = format!("{}{}", state.hf_complex_url, api_path);
        
        let mut req = client.post(&target_url)
            .json(&serde_json::json!({
                "model": "llama-3.1-8b",
                "messages": [
                    { "role": "system", "content": "あなたはG1:Mちゃんです。フレンドリーで親しみやすい日本語で回答してください。" },
                    { "role": "user", "content": payload.prompt }
                ],
                "max_tokens": 512,
                "temperature": 0.8
            }));
            
        if !state.huggingface_token.is_empty() {
            req = req.bearer_auth(&state.huggingface_token);
        }
        
        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        let mut text = data["choices"][0]["message"]["content"]
                            .as_str()
                            .unwrap_or("回答を生成できませんでした。")
                            .to_string();
                        text = format!("【HF Node】 {}", text);

                        // AIの回答を全クライアントにブロードキャスト
                        let _ = state.io.emit("bot_response", serde_json::json!({ "text": text, "actionName": "" }));

                        return Json(LlmResponse { response: text.clone(), text }).into_response();
                    }
                }
                log::warn!("HF status code not success: {:?}", status);
            }
            Err(e) => {
                log::error!("HF request failed: {:?}", e);
            }
        }
    }

    // 全ての手段が失敗した場合
    log::error!("❌ No inference nodes available (Local, Staff, or HF).");
    (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
        "error": "No available AI node found anywhere.",
        "response": "現在、応答できるAIノードがありません。"
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
    // Resolve relative path to z1m/AirWallet
    let paths_to_try = vec![
        PathBuf::from("z1m/AirWallet/g1-m_chan.jpeg"),
        PathBuf::from("../z1m/AirWallet/g1-m_chan.jpeg"),
        PathBuf::from("./z1m/AirWallet/g1-m_chan.jpeg"),
    ];
    
    let mut file_data = None;
    for path in paths_to_try {
        if path.exists() {
            if let Ok(data) = fs::read(path) {
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
        (StatusCode::NOT_FOUND, "Bot QR file not found").into_response()
    }
}

async fn handle_get_wallet(
    State(state): State<AppState>,
    Path(anonymous_id): Path<String>,
) -> impl IntoResponse {
    let db = state.db_conn.lock().unwrap();
    let mut stmt = match db.prepare("SELECT image, wallet_type FROM messages WHERE sender_name = ?1 AND image IS NOT NULL LIMIT 1") {
        Ok(stmt) => stmt,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "DB Error").into_response(),
    };
    
    let result = stmt.query_row([&anonymous_id], |row| {
        let img: String = row.get(0)?;
        let w_type: Option<String> = row.get(1)?;
        Ok((img, w_type.unwrap_or_else(|| "AirWallet".to_string())))
    });
    
    match result {
        Ok((img, w_type)) => Json(serde_json::json!({
            "anonymous_id": anonymous_id,
            "wallet_image_data": img,
            "wallet_type": w_type
        })).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Wallet not found").into_response(),
    }
}

async fn handle_register_wallet(
    State(state): State<AppState>,
    Json(payload): Json<WalletRegisterRequest>,
) -> impl IntoResponse {
    let db = state.db_conn.lock().unwrap();
    let res = db.execute(
        "INSERT OR REPLACE INTO messages (id, text, image, is_user, sender_name)
         VALUES (?1, ?2, ?3, 1, ?4)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            "AirWallet registered",
            payload.wallet_image_data,
            payload.anonymous_id
        ],
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
    pub nickname: Option<String>,
}

pub fn create_router(state: AppState, socketio_layer: SocketIoLayer) -> Router { // socketio_layerを引数で受け取る
    let io = state.io.clone();
    let st = state.clone();

    io.ns("/", move |socket: SocketRef| {
        log::info!("Socket.IO Connected: {}", socket.id);

        // チャットメッセージの受信とブロードキャスト
        socket.on("chat_message", {
            let st = st.clone();
            move |socket: SocketRef, Data(payload): Data<Value>| {
                log::info!("Chat received from {}: {:?}", socket.id, payload["text"]);
                
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
            let nickname = payload.nickname.clone().unwrap_or_else(|| "ゲスト".to_string());
            let info = ParticipantInfo { id: socket.id.to_string(), role: payload.role.clone(), anonymous_id: payload.anonymous_id.clone(), nickname: nickname.clone(), };
            { let mut parts = st.participants.lock().unwrap(); parts.insert(socket.id.to_string(), info.clone()); let others: Vec<ParticipantInfo> = parts.values().filter(|p| p.id != socket.id.to_string()).cloned().collect(); let _ = socket.emit("participants_list", others); }
            log::info!("Register role: {} as {}", socket.id, payload.role); let _ = socket.broadcast().emit("participant_joined", info);
        }});

        socket.on("update_nickname", { let st = st.clone(); move |socket: SocketRef, Data(payload): Data<Value>| {
            let nickname = payload["nickname"].as_str().unwrap_or("ゲスト").to_string();
            { let mut parts = st.participants.lock().unwrap(); if let Some(p) = parts.get_mut(&socket.id.to_string()) { p.nickname = nickname.clone(); } }
            let _ = socket.broadcast().emit("participant_updated", serde_json::json!({ "id": socket.id.to_string(), "nickname": nickname }));
        }});

        socket.on("offer", { let rs = relay_signal.clone(); move |socket: SocketRef, Data(payload): Data<Value>| { let target_id = payload["targetId"].as_str().unwrap_or_default().to_string(); rs(socket, "offer".to_string(), target_id, payload); } });
        socket.on("answer", { let rs = relay_signal.clone(); move |socket: SocketRef, Data(payload): Data<Value>| { let target_id = payload["targetId"].as_str().unwrap_or_default().to_string(); rs(socket, "answer".to_string(), target_id, payload); } });
        socket.on("candidate", { let rs = relay_signal.clone(); move |socket: SocketRef, Data(payload): Data<Value>| { let target_id = payload["targetId"].as_str().unwrap_or_default().to_string(); rs(socket, "candidate".to_string(), target_id, payload); } });

        socket.on_disconnect({ let st = st.clone(); move |socket: SocketRef, _reason: DisconnectReason| {
            { let mut parts = st.participants.lock().unwrap(); parts.remove(&socket.id.to_string()); }
            log::info!("Socket disconnected: {}", socket.id);
            let _ = socket.broadcast().emit("participant_left", serde_json::json!({ "id": socket.id.to_string() }));
        }});

        socket.on("task_result", { let st = st.clone(); move |_socket: SocketRef, Data(payload): Data<Value>| {
            let result = payload["result"].as_str().unwrap_or("").to_string();
            let msg = serde_json::json!({ "text": result, "actionName": "" });
            // 全員（AIの回答を待っているユーザー全員）に送信
            let _ = st.io.emit("bot_response", msg);
            
            // タスク完了をP2P全体に通知（チャット形式でリザルトを共有）
            let _ = st.p2p_tx.try_send(P2PCommand::PublishChat {
                id: uuid::Uuid::new_v4().to_string(),
                text: format!("[P2P Success] {}", result),
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
