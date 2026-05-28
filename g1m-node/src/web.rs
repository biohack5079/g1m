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
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tokio::sync::mpsc;
use std::path::PathBuf;
use std::fs;

use crate::p2p::P2PCommand;

#[derive(Clone)]
pub struct AppState {
    pub db_conn: Arc<Mutex<rusqlite::Connection>>,
    pub p2p_tx: mpsc::Sender<P2PCommand>,
    pub llm_api_url: String,
    pub hf_complex_url: String,
    pub huggingface_token: String,
    pub ollama_url: String,
    pub participants: Arc<Mutex<HashMap<String, ParticipantInfo>>>,
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
    Json(payload): Json<LlmRequest>,
) -> impl IntoResponse {
    let client = reqwest::Client::new();
    
    // 1. Try Hugging Face first
    if !state.hf_complex_url.is_empty() {
        log::info!("Trying Hugging Face LLM endpoint...");
        let api_path = if state.hf_complex_url.ends_ok() {
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
                        let text = data["choices"][0]["message"]["content"]
                            .as_str()
                            .unwrap_or("回答を生成できませんでした。")
                            .to_string();
                        return Json(LlmResponse { response: text.clone(), text }).into_response();
                    }
                }
                log::warn!("HF status code not success: {:?}", status);
            }
            Err(e) => {
                log::warn!("HF request failed: {:?}", e);
            }
        }
    }
    
    // 2. Failover to Local Ollama
    log::info!("Falling back to Local Ollama at {}...", state.ollama_url);
    let ollama_endpoint = format!("{}/api/chat", state.ollama_url);
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
                    let text = data["message"]["content"]
                        .as_str()
                        .unwrap_or("回答を生成できませんでした。")
                        .to_string();
                    return Json(LlmResponse { response: text.clone(), text }).into_response();
                }
            }
        }
        Err(e) => {
            log::error!("Local Ollama query failed: {:?}", e);
        }
    }
    
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
        "error": "LLM failed both remote HF and local Ollama failover"
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

// SocketIO Signaling & Relay Logic
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RegisterPayload {
    pub role: String,
    #[serde(rename = "anonymousId")]
    pub anonymous_id: Option<String>,
    pub nickname: Option<String>,
}

pub fn create_router(state: AppState) -> (Router, SocketIo) {
    let (socketio_layer, io) = SocketIo::new_layer();
    let st = state.clone();

    io.ns("/", move |socket: SocketRef| {
        log::info!("Socket.IO Connected: {}", socket.id);
        let st = st.clone();

        socket.on("register_role", move |socket: SocketRef, Data(payload): Data<RegisterPayload>| {
            let nickname = payload.nickname.clone().unwrap_or_else(|| "ゲスト".to_string());
            let info = ParticipantInfo {
                id: socket.id.to_string(),
                role: payload.role.clone(),
                anonymous_id: payload.anonymous_id.clone(),
                nickname: nickname.clone(),
            };

            {
                let mut parts = st.participants.lock().unwrap();
                parts.insert(socket.id.to_string(), info.clone());
                
                let others: Vec<ParticipantInfo> = parts.values()
                    .filter(|p| p.id != socket.id.to_string())
                    .cloned()
                    .collect();
                let _ = socket.emit("participants_list", others);
            }

            log::info!("Register role: {} as {}", socket.id, payload.role);
            let _ = socket.broadcast().emit("participant_joined", info);
        });

        socket.on("update_nickname", move |socket: SocketRef, Data(payload): Data<Value>| {
            let nickname = payload["nickname"].as_str().unwrap_or("ゲスト").to_string();
            {
                let mut parts = st.participants.lock().unwrap();
                if let Some(p) = parts.get_mut(&socket.id.to_string()) {
                    p.nickname = nickname.clone();
                }
            }
            let _ = socket.broadcast().emit("participant_updated", serde_json::json!({
                "id": socket.id.to_string(),
                "nickname": nickname
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
            let _ = socket.to(target_id.clone()).emit(event_name.clone(), local_msg); // local_msg はここでムーブされます

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

        socket.on_disconnect({ let st = st.clone(); move |socket: SocketRef, _| {
            { let mut parts = st.participants.lock().unwrap(); parts.remove(&socket.id.to_string()); }
            let _ = socket.broadcast().emit("participant_left", serde_json::json!({ "id": socket.id.to_string() }));
        }});

    });

    let router = Router::new()
        .route("/healthz", get(health_check))
        .route("/api/llm", post(handle_llm))
        .route("/api/process", post(handle_process))
        .route("/api/kampa/wallet/bot", get(handle_bot_wallet))
        .route("/api/kampa/wallet/:anonymousId", get(handle_get_wallet))
        .route("/api/kampa/wallet/register", post(handle_register_wallet))
        .route("/api/kampa/donate", post(handle_donate))
        .layer(socketio_layer)
        .layer(CorsLayer::permissive())
        .with_state(state.clone())
        // Fallback for static assets in frontend/dist
        .fallback_service(ServeDir::new("frontend/dist").fallback(ServeDir::new("../frontend/dist")));

    (router, io)
}
