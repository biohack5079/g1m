mod db;
mod p2p;
mod web;

use std::sync::{Arc, Mutex};
use std::time::Duration;
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

    // 3. Start Libp2p node in background task
    log::info!("Starting Libp2p node on port {}...", p2p_port);
    tokio::spawn(async move {
        if let Err(e) = p2p::run_p2p_node(p2p_rx, event_tx, p2p_port).await {
            log::error!("P2P swarm loop terminated with error: {:?}", e);
        }
    });

    // 4. Handle incoming Libp2p events in a separate task
    let db_event_clone = db_shared.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            match event {
                p2p::P2PEvent::PeerDiscovered(peer_id) => {
                    log::info!("Discovered new peer: {:?}", peer_id);
                }
                p2p::P2PEvent::PeerExpired(peer_id) => {
                    log::info!("Peer expired: {:?}", peer_id);
                }
                p2p::P2PEvent::ChatMessageReceived { id, text, sender_name } => {
                    log::info!("Received chat message from P2P network: [{}]: {}", sender_name, text);
                    let db = db_event_clone.lock().unwrap();
                    let _ = db::save_message(&db, &id, &text, None, true, &sender_name);
                }
                p2p::P2PEvent::DatabaseSyncReceived { table, data } => {
                    log::info!("Received DB sync event for table '{}'", table);
                    // Parse sync item and save it
                    if table == "knowledge_base" {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                            let db = db_event_clone.lock().unwrap();
                            let content = val["content"].as_str().unwrap_or_default();
                            let embedding: Vec<f32> = val["embedding"]
                                .as_array()
                                .unwrap_or(&vec![])
                                .iter()
                                .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                                .collect();
                            let metadata = val["metadata"].clone();
                            let _ = db::add_knowledge(&db, content, &embedding, &metadata);
                        }
                    }
                }
                p2p::P2PEvent::SignalReceived { target_id, payload } => {
                    // Signaling over Libp2p fallback (not strictly required if WebRTC directly connects,
                    // but enables signaling redundancy across nodes)
                    log::info!("Received P2P signal payload for target: {}", target_id);
                }
            }
        }
    });

    // 5. Start Axum web server
    let state = web::AppState {
        db_conn: db_shared,
        p2p_tx,
        llm_api_url,
        hf_complex_url,
        huggingface_token,
        ollama_url,
    };
    
    let app = web::create_router(state);
    
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    log::info!("🚀 Axum signaling & web server running on http://localhost:{}", port);
    axum::serve(listener, app).await?;

    Ok(())
}
