mod db;
mod p2p;
mod web;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use dotenvy::dotenv;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    
    // Load .env if present
    let _ = dotenv();
    
    // Load config from environment variables
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse::<u16>()
        .unwrap_or(3000);
        
    let p2p_port = std::env::var("P2P_PORT")
        .unwrap_or_else(|_| "4001".to_string())
        .parse::<u16>()
        .unwrap_or(4001);
        
    let hf_complex_url = std::env::var("HF_COMPLEX_URL")
        .unwrap_or_else(|_| "".to_string());
        
    let llm_api_url = std::env::var("LLM_API_URL")
        .unwrap_or_else(|_| "".to_string());
        
    let huggingface_token = std::env::var("HUGGINGFACE_TOKEN")
        .unwrap_or_else(|_| "".to_string());
        
    let ollama_url = std::env::var("OLLAMA_URL")
        .unwrap_or_else(|_| "http://localhost:11434".to_string());

    // 1. Initialize SQLite Database
    log::info!("Initializing SQLite database...");
    let db_conn = db::init_db("sagbi.db")?;
    let db_shared = Arc::new(Mutex::new(db_conn));

    // 2. Set up communication channels between Axum and Libp2p
    let (p2p_tx, p2p_rx) = mpsc::channel(100);
    let (event_tx, mut event_rx) = mpsc::channel(100);

    let state = web::AppState {
        db_conn: db_shared.clone(),
        p2p_tx,
        hf_complex_url,
        huggingface_token,
        ollama_url,
        participants: Arc::new(Mutex::new(HashMap::new())),
    };
    
    let (app, io) = web::create_router(state);

    // 4. Start Libp2p node
    log::info!("Starting Libp2p node on port {}...", p2p_port);
    tokio::spawn(async move {
        if let Err(e) = p2p::run_p2p_node(p2p_rx, event_tx, p2p_port).await {
            log::error!("P2P swarm loop terminated with error: {:?}", e);
        }
    });

    // 5. Libp2pイベントとSocket.IOの統合
    let db_event_clone = db_shared.clone();
    let io_clone = io.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            match event {
                p2p::P2PEvent::ChatMessageReceived { id, text, sender_name } => {
                    {
                        let db = db_event_clone.lock().unwrap();
                        let _ = db::save_message(&db, &id, &text, None, true, &sender_name);
                    }
                    let _ = io_clone.emit("chat_message", serde_json::json!({
                        "id": id, "text": text, "senderName": sender_name
                    }));
                }
                p2p::P2PEvent::DatabaseSyncReceived { table, data } => {
                    if table == "knowledge_base" {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                            let db = db_event_clone.lock().unwrap();
                            let content = val["content"].as_str().unwrap_or_default().to_string();
                            let embedding: Vec<f32> = val["embedding"].as_array()
                                .map(|arr| arr.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect())
                                .unwrap_or_default();
                            let metadata = val["metadata"].clone();
                            let _ = db::add_knowledge(&db, &content, &embedding, &metadata);
                        }
                    }
                }
                p2p::P2PEvent::SignalReceived { target_id, payload } => {
                    log::info!("Relaying P2P signal to local socket: {}", target_id);
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&payload) {
                        let event_type = val["type"].as_str().unwrap_or_default().to_string();
                        let data = val["data"].clone();
                        // ターゲットがこのノードに接続していれば、Socket.IO経由で配送
                        let _ = io_clone.to(target_id).emit(event_type, data);
                    }
                }
                _ => {}
            }
        }
    });
    
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    log::info!("🚀 Axum signaling & web server running on http://localhost:{}", port);
    axum::serve(listener, app).await?;

    Ok(())
}
