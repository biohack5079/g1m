mod db;
mod p2p;
mod web;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use socketioxide::SocketIo;
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
        
    let ollama_url = std::env::var("OLLAMA_HOST")
        .or_else(|_| std::env::var("OLLAMA_URL"))
        .unwrap_or_else(|_| "".to_string());

    let ollama_model = std::env::var("OLLAMA_MODEL")
        .unwrap_or_else(|_| "gemma3:4b-it-q4_K_M".to_string());

    // 1. Initialize SQLite Database
    log::info!("Initializing SQLite database...");
    let db_conn = db::init_db("../g1m.db")?; // プロジェクトルートのDBを使用
    let db_shared = Arc::new(Mutex::new(db_conn));

    // 1.5 起動時のデータベース検証
    {
        let db = db_shared.lock().unwrap();
        let recent = db::get_recent_messages(&db, 10).unwrap_or_default();
        log::info!("Database ready: {} messages found.", recent.len());
        
        // RAG機能のウォームアップ
        let dummy_vector = vec![0.0; 384]; 
        // 第3引数(threshold)を 0.5、第4引数(limit)を 1 として呼び出し
        let _ = db::match_knowledge(&db, &dummy_vector, 0.5, 1);
    }

    // 2. Set up communication channels between Axum and Libp2p
    let (p2p_tx, p2p_rx) = mpsc::channel(100);
    let (event_tx, mut event_rx) = mpsc::channel(100);

    // 1.8 HTTPクライアントの初期化 (Timeout: 1 hour for LLM)
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()?;

    // 3. Set up Socket.IO
    let (socketio_layer, io) = SocketIo::builder()
        .ping_interval(Duration::from_secs(25))
        .ping_timeout(Duration::from_secs(60))
        .build_layer();

    log::info!("LLM Routes: Local={}, Fallback={}, HF_SuperNode={}", ollama_url, llm_api_url, hf_complex_url);

    let state = web::AppState {
        db_conn: db_shared.clone(),
        p2p_tx: p2p_tx.clone(),
        hf_complex_url,
        huggingface_token,
        ollama_url,
        ollama_model,
        participants: Arc::new(Mutex::new(HashMap::new())),
        help_gauge: Arc::new(Mutex::new(50)), // 初期値 50%
        io: io.clone(), // SocketIoインスタンスをAppStateに含める
        client,
    };
    
    let app = web::create_router(state, socketio_layer);

    // 4. Start Libp2p node
    log::info!("Starting Libp2p node on port {}...", p2p_port);
    tokio::spawn(async move {
        if let Err(e) = p2p::run_p2p_node(p2p_rx, event_tx, p2p_port).await {
            log::error!("P2P swarm loop terminated with error: {:?}", e);
        }
    });

    // 4.5 データベース同期タスク (SyncDatabaseの構築)
    let p2p_tx_sync = p2p_tx.clone();
    let db_sync = db_shared.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300)); // 5分ごとに同期
        interval.tick().await; // 起動直後の即時実行をスキップし、P2Pピアの発見を待つ
        loop {
            interval.tick().await;

            // データベースから同期用データを抽出 (ロックをこのブロック内で完結させる)
            let sync_data = {
                let db = db_sync.lock().unwrap();
                db::get_recent_messages(&db, 50).ok()
                    .and_then(|messages| serde_json::to_string(&messages).ok())
            }; // ここで MutexGuard がドロップされる

            if let Some(data) = sync_data {
                let _ = p2p_tx_sync.send(p2p::P2PCommand::SyncDatabase {
                    table: "chat_history".to_string(),
                    data,
                }).await; // ロックを保持していないので安全に await 可能
            }
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
                    // P2P経由のメッセージを送信者以外に共有（エコー防止のため broadcast 相当の挙動を期待）
                    // 実際にはSocket.IOサーバー全体でemitするが、フロントエンド側でID重複チェックを行うのが理想的
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
                    if table == "chat_history" {
                        if let Ok(messages) = serde_json::from_str::<Vec<db::Message>>(&data) {
                            let db = db_event_clone.lock().unwrap();
                            for msg in messages {
                                let _ = db::save_message(
                                    &db, 
                                    &msg.id, 
                                    &msg.text, 
                                    msg.image.as_deref(), 
                                    msg.is_user, 
                                    &msg.sender_name
                                );
                            }
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
                p2p::P2PEvent::PeerDiscovered(peer_id) => {
                    log::info!("📡 New P2P Node discovered: {:?}", peer_id);
                }
                p2p::P2PEvent::PeerExpired(peer_id) => {
                    log::warn!("🔌 P2P Node expired/disconnected: {:?}", peer_id);
                }
            }
        }
    });
    
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    log::info!("🚀 Axum signaling & web server running on http://localhost:{}", port);
    axum::serve(listener, app).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use reqwest::Client;
    use std::time::Duration;

    #[tokio::test]
    async fn test_local_ollama_availability() {
        let ollama_url = std::env::var("OLLAMA_HOST")
            .or_else(|_| std::env::var("OLLAMA_URL"))
            .unwrap_or_else(|_| "http://localhost:11434".to_string());

        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();

        // OllamaのタグAPIを叩いて接続確認
        let endpoint = format!("{}/api/tags", ollama_url.trim_end_matches('/'));
        let res = client.get(&endpoint).send().await;

        match res {
            Ok(resp) => {
                assert!(resp.status().is_success(), "Ollama endpoint found but returned error status");
                println!("✅ Local Ollama is reachable at {}", endpoint);
            }
            Err(e) => panic!("❌ Local Ollama is not reachable at {}: {:?}", endpoint, e),
        }
    }
}
