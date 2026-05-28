use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub text: String,
    pub image: Option<String>,
    pub is_user: bool,
    pub sender_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeItem {
    pub id: String,
    pub content: String,
    pub similarity: f32,
    pub metadata: Option<Value>,
}

pub fn init_db(path: &str) -> Result<Connection> {
    let conn = Connection::open(path)?;

    // Create messages table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            image TEXT,
            is_user INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // Create knowledge_base table for RAG vector search
    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_base (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            embedding TEXT, -- Serialized JSON array of f32
            metadata TEXT,  -- Serialized JSON object
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    Ok(conn)
}

pub fn save_message(
    conn: &Connection,
    id: &str,
    text: &str,
    image: Option<&str>,
    is_user: bool,
    sender_name: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO messages (id, text, image, is_user, sender_name)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, text, image, if is_user { 1 } else { 0 }, sender_name],
    )?;
    Ok(())
}

pub fn get_recent_messages(conn: &Connection, limit: usize) -> Result<Vec<Message>> {
    let mut stmt = conn.prepare(
        "SELECT id, text, image, is_user, sender_name, created_at
         FROM messages
         ORDER BY created_at DESC
         LIMIT ?1",
    )?;
    let msg_iter = stmt.query_map([limit], |row| {
        let is_user_int: i32 = row.get(3)?;
        Ok(Message {
            id: row.get(0)?,
            text: row.get(1)?,
            image: row.get(2)?,
            is_user: is_user_int != 0,
            sender_name: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;

    let mut messages = Vec::new();
    for msg in msg_iter {
        messages.push(msg?);
    }
    // Reverse so it's in chronological order
    messages.reverse();
    Ok(messages)
}

pub fn add_knowledge(
    conn: &Connection,
    content: &str,
    embedding: &[f32],
    metadata: &Value,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let embedding_str = serde_json::to_string(embedding).unwrap_or_default();
    let metadata_str = serde_json::to_string(metadata).unwrap_or_default();

    conn.execute(
        "INSERT OR REPLACE INTO knowledge_base (id, content, embedding, metadata)
         VALUES (?1, ?2, ?3, ?4)",
        params![id, content, embedding_str, metadata_str],
    )?;
    Ok(id)
}

pub fn cosine_similarity(v1: &[f32], v2: &[f32]) -> f32 {
    if v1.len() != v2.len() || v1.is_empty() {
        return 0.0;
    }
    let dot_product: f32 = v1.iter().zip(v2.iter()).map(|(a, b)| a * b).sum();
    let norm_v1: f32 = v1.iter().map(|a| a * a).sum::<f32>().sqrt();
    let norm_v2: f32 = v2.iter().map(|a| a * a).sum::<f32>().sqrt();
    if norm_v1 == 0.0 || norm_v2 == 0.0 {
        0.0
    } else {
        dot_product / (norm_v1 * norm_v2)
    }
}

pub fn match_knowledge(
    conn: &Connection,
    query_embedding: &[f32],
    threshold: f32,
    count: usize,
) -> Result<Vec<KnowledgeItem>> {
    let mut stmt = conn.prepare("SELECT id, content, embedding, metadata FROM knowledge_base")?;
    let items_iter = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let content: String = row.get(1)?;
        let embedding_str: Option<String> = row.get(2)?;
        let metadata_str: Option<String> = row.get(3)?;

        let embedding: Vec<f32> = embedding_str
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let metadata: Option<Value> = metadata_str
            .and_then(|s| serde_json::from_str(&s).ok());

        Ok((id, content, embedding, metadata))
    })?;

    let mut matches = Vec::new();
    for item in items_iter {
        let (id, content, embedding, metadata) = item?;
        if embedding.is_empty() {
            continue;
        }
        let similarity = cosine_similarity(query_embedding, &embedding);
        if similarity > threshold {
            matches.push(KnowledgeItem {
                id,
                content,
                similarity,
                metadata,
            });
        }
    }

    // Sort by similarity descending
    matches.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap());
    matches.truncate(count);

    Ok(matches)
}
