use std::env;
use std::fs;
use std::thread;
use std::time::Duration;
use std::io::{self, Write};
use std::process::{Command, Stdio};
use std::path::{Path, PathBuf};

#[cfg(windows)]
const OLLAMA_INSTALLER_URL: &str = "https://ollama.com/download/OllamaSetup.exe";
const TARGET_MODEL: &str = "gemma3:4b-it-q4_K_M";

/// プロジェクトのルートディレクトリを探す（./g1m-node がなければ ../g1m-node を確認）
fn find_project_root() -> io::Result<PathBuf> {
    if Path::new("g1m-node").exists() && Path::new("frontend").exists() {
        Ok(env::current_dir().unwrap())
    } else if Path::new("../g1m-node").exists() && Path::new("../frontend").exists() {
        Ok(env::current_dir().unwrap().parent().unwrap().to_path_buf())
    } else {
        Err(io::Error::new(io::ErrorKind::NotFound, "g1m-node または frontend フォルダが見つかりません。\nプロジェクトのルートフォルダ、または dist フォルダ内で実行してください。"))
    }
}

fn main() {
    if let Err(e) = run_app() {
        eprintln!("\n❌ エラーが発生しました: {}", e);
        println!("\nプログラムを終了するには Enter キーを押してください...");
        let _ = io::stdin().read_line(&mut String::new());
        std::process::exit(1);
    }
}

fn run_app() -> io::Result<()> {
    println!("--- G1M P2P Clustered Launcher ---");
    println!("※ 初回起動時はビルドとモデル取得に数分かかります。そのままお待ちください。\n");

    let root = find_project_root()?;
    println!("📂 Project Root: {:?}", root);

    // 1. 環境変数の設定
    setup_environment(&root);

    // 2. Windows限定処理
    if cfg!(windows) {
        setup_windows_specific()?;
    }

    // 3. 依存関係のチェック
    check_dependencies()?;

    // 4. Ollama モデルの準備
    setup_ollama_model()?;

    // 5. ビルド処理
    build_all(&root)?;

    // 6. サービスの実行
    run_services(&root)
}

fn setup_environment(root: &Path) {
    if env::var("REMOTE_G1M_URL").is_err() {
        env::set_var("REMOTE_G1M_URL", "https://dj-g1m.onrender.com");
    }
    env::set_var("OLLAMA_URL", "http://127.0.0.1:11434");
    if env::var("OLLAMA_MODEL").is_err() {
        env::set_var("OLLAMA_MODEL", TARGET_MODEL);
    }
    if env::var("BOT_CNC_ID").is_err() {
        env::set_var("BOT_CNC_ID", "bot");
    }

    let node_id_path = root.join(".g1m_node_id");
    let node_id = if node_id_path.exists() {
        fs::read_to_string(node_id_path).unwrap_or_default()
    } else {
        let id = format!("NODE-{}-{}", chrono::Utc::now().timestamp(), rand::random::<u16>());
        fs::write(&node_id_path, &id).ok();
        id
    };
    env::set_var("G1M_POC_TOKEN", format!("[PC-{}]", node_id.trim()));
}

#[cfg(windows)]
fn setup_windows_specific() -> io::Result<()> {
    println!("[Windows] Hugging Faceのトークンを入力してください (任意):");
    println!("※ トークンを入れるとHF経由のバックアップ推論が有効になります。不要な場合はEnter。");
    print!("HF_TOKEN > "); io::stdout().flush()?;
    let mut token = String::new();
    io::stdin().read_line(&mut token)?;
    let token = token.trim();

    if !token.is_empty() {
        env::set_var("HUGGING_FACE_HUB_TOKEN", token);
        println!("✅ HFトークンを設定しました。");
    }

    // Ollamaがインストールされているか確認
    if Command::new("ollama").arg("--version").status().is_err() {
        println!("[Info] Ollamaが見つかりません。インストールを開始します...");
        // wingetを使用してインストールを試行
        let status = Command::new("winget")
            .args(["install", "-e", "--id", "Ollama.Ollama"])
            .status();

        if status.is_err() || !status.unwrap().success() {
            println!("[Error] wingetでのインストールに失敗しました。");
            println!("ブラウザを開いて {} から手動でインストールしてください。", OLLAMA_INSTALLER_URL);
        } else {
            println!("✅ Ollamaのインストールを要求しました。セットアップ完了まで待機します...");
            // インストール反映待ちのため少し待つ
            thread::sleep(Duration::from_secs(10));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn setup_windows_specific() -> io::Result<()> { Ok(()) }

fn check_dependencies() -> io::Result<()> {
    println!("[1/4] 開発ツールのチェック...");

    // Node.js 本体
    if Command::new("node").arg("--version").status().is_err() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "Node.js が見つかりません。https://nodejs.org/ からインストールしてください。"));
    }

    // Rust
    if Command::new("cargo").arg("--version").status().is_err() {
        if cfg!(unix) {
            println!("Rustをインストールしています...");
            Command::new("sh").arg("-c").arg("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y").status()?;
        } else {
            println!("[Error] Rust (cargo) が見つかりません。https://rustup.rs/ からインストールしてください。");
            std::process::exit(1);
        }
    }

    // Node.js
    if Command::new("npm").arg("--version").status().is_err() {
        println!("[Error] Node.js (npm) が見つかりません。インストールしてください。");
        std::process::exit(1);
    }

    Ok(())
}

fn setup_ollama_model() -> io::Result<()> {
    println!("[2/4] Ollamaモデルの準備: {}", TARGET_MODEL);

    if let Err(_) = Command::new("ollama").arg("serve").spawn() {
        println!("⚠️ Ollama サーバーを起動できませんでした。");
        println!("   Ollamaがインストールされているか、既に起動していないか確認してください。");
    } else {
        println!("-> Ollama サーバーをバックグラウンドで開始しました。");
    }

    print!("Ollama サービスの応答を待機中...");
    for i in 0..15 {
        let check = Command::new("curl").args(["-s", "http://127.0.0.1:11434/api/tags"]).output();
        if check.is_ok() && check.as_ref().unwrap().status.success() {
            println!(" OK!");
            break;
        }
        if i == 14 { println!(" ⚠️ タイムアウト。モデル取得を強行します。"); }
        print!("."); io::stdout().flush()?;
        thread::sleep(Duration::from_secs(2));
    }

    println!("モデルをプルしています (初回は数分かかる場合があります)...");
    let _ = Command::new("ollama").args(["pull", TARGET_MODEL]).status();
    println!("✅ AIモデルの準備が完了しました。");

    Ok(())
}

fn build_all(root: &Path) -> io::Result<()> {
    println!("[3/4] プロジェクトをビルド中...");

    println!("-> g1m-node をビルド中...");
    Command::new("cargo")
        .args(["build", "--release"])
        .current_dir(root.join("g1m-node"))
        .status()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let node_bin = root.join("g1m-node/target/release/g1m-node");
        if let Ok(metadata) = fs::metadata(&node_bin) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o755); // rwxr-xr-x
            fs::set_permissions(&node_bin, perms)?;
            println!("-> g1m-node に実行権限を付与しました。");
        }
    }

    if !root.join("frontend/node_modules").exists() {
        println!("-> フロントエンドの依存関係をインストール中...");
        Command::new("npm").arg("install").current_dir(root.join("frontend")).status()?;
    }

    println!("-> フロントエンドをビルド中...");
    let mut npm_build = Command::new("npm");
    npm_build.args(["run", "build"]).current_dir(root.join("frontend"));
    
    #[cfg(unix)]
    npm_build.env("NODE_OPTIONS", "--max-old-space-size=1024");
    
    npm_build.status()?;

    Ok(())
}

fn run_services(root: &Path) -> io::Result<()> {
    println!("[4/4] サービスを起動中...");

    #[cfg(unix)]
    {
        println!("🧹 古いプロセスの掃除中...");
        let _ = Command::new("fuser").args(["-k", "3000/tcp", "4001/tcp", "11434/tcp"]).stderr(Stdio::null()).status();
        let _ = Command::new("pkill").args(["-9", "-f", "g1m-node"]).stderr(Stdio::null()).status();
        let _ = Command::new("pkill").args(["-9", "-f", "node -e"]).stderr(Stdio::null()).status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill").args(["/F", "/IM", "g1m-node.exe", "/T"]).stderr(Stdio::null()).status();
        let _ = Command::new("taskkill").args(["/F", "/IM", "node.exe", "/T"]).stderr(Stdio::null()).status();
    }

    let mut node_bin = root.join("g1m-node/target/release/g1m-node");
    if cfg!(windows) { node_bin.set_extension("exe"); }

    println!("🚀 P2P Node を起動中: {:?}", node_bin);
    let mut node_proc = Command::new(&node_bin)
        .current_dir(root)
        .spawn()?;

    println!("✅ Rust P2P Node 起動 (PID: {})", node_proc.id());

    let bridge_script = r#"
const io = require('socket.io-client');
const connectionOptions = {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    pingInterval: 20000, 
    pingTimeout: 60000,
    upgradeTimeout: 30000
};
const REMOTE_URL = process.env.REMOTE_G1M_URL || 'https://dj-g1m.onrender.com';
const socket = io(REMOTE_URL, connectionOptions);
const localSocket = io('http://localhost:3000', connectionOptions);
let lastFeedback = "";
let lastTask = null;

const register = (s, name) => {
    s.on('connect', () => {
        s.emit('register_role', { role: 'staff', pocToken: process.env.G1M_POC_TOKEN, nickname: 'Local-PC-Rust' });
        console.log(`✅ [BRIDGE] ${name} に接続成功 (${new Date().toLocaleTimeString()})`);
    });
    s.on('disconnect', (reason) => {
        console.warn(`⚠️ [BRIDGE] ${name} から切断されました: ${reason}`);
    });
    s.on('connect_error', (err) => {
        console.error(`❌ [BRIDGE] ${name} 接続エラー: ${err.message}`);
    });
};

register(socket, 'Remote Hub');
register(localSocket, 'Local Node');

// ブラウザからの物理センサー情報（固有感覚）を受信
localSocket.on('motion_verified', (data) => {
    const feedbackStr = `【前回のダンス自己評価: ${data.detail || '計測中'}】`;
    lastFeedback = feedbackStr;
    
    if (lastTask) {
        console.log('\n--- 🔁 反省と改善のループ (Reflection) ---');
        console.log(`🎯 意図(Intent): "${lastTask.prompt.substring(0, 60)}..."`);
        console.log(`💪 実際(Reality): ${data.detail}`);
        console.log('------------------------------------------\n');
    }
});

const handleTask = async (s, data) => {
    console.log(`\n📥 [BRIDGE] タスク受信: ${data.taskId.substring(0,8)} - "${data.prompt.substring(0,30)}..."`);
    s.emit('system_log', { message: `⚡ ローカルPC (${new Date().toLocaleTimeString()}) で推論を開始しました...` });
    lastTask = data;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3600000); // 1時間タイムアウト

    try {
        const res = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                model: process.env.OLLAMA_MODEL,
                messages: [
                    { role: 'system', content: 'あなたはG1:Mちゃんです。前回の動きへの反省を活かし、親しみやすい日本語で回答してください。' },
                    { role: 'user', content: lastFeedback + data.prompt }
                ],
                options: { num_predict: 512 }
            }),
            signal: controller.signal
        });
        const json = await res.json();
        // OpenAI互換形式とOllama標準形式の両方をチェック
        const text = (json.choices && json.choices[0] && json.choices[0].message) ? json.choices[0].message.content : (json.message ? json.message.content : (json.response || "⚠️ Ollamaからの応答が空でした。"));
        s.emit('task_result', { taskId: data.taskId, result: text });
        console.log(`✅ [BRIDGE] 推論完了。結果を返送しました。`);
    } catch (e) {
        console.error(`❌ [BRIDGE] エラー: ${e.message}`);
        s.emit('task_result', { taskId: data.taskId, result: "⚠️ ローカルAIとの通信に失敗しました。" });
    } finally {
        clearTimeout(timeoutId);
    }
};

socket.on('distribute_task', (data) => handleTask(socket, data));
localSocket.on('distribute_task', (data) => handleTask(localSocket, data));
    "#;

    let mut bridge_proc = Command::new("node")
        .arg("-e")
        .arg(bridge_script)
        .current_dir(root)
        .env("NODE_PATH", root.join("frontend/node_modules"))
        .spawn()?;

    println!("✅ JS Bridge 起動 (PID: {})", bridge_proc.id());
    println!("\n--- G1M is now running! ---");
    println!("Web interface: http://localhost:3000");
    println!("終了するには、このウィンドウを閉じるか Ctrl+C を押してください。");

    // どちらかが死んだら両方殺して終了する監視ループ
    loop {
        if let Ok(Some(status)) = node_proc.try_wait() {
            println!("⚠️ P2P Node が終了しました ({})。全サービスを停止します...", status);
            let _ = bridge_proc.kill();
            break;
        }
        if let Ok(Some(status)) = bridge_proc.try_wait() {
            println!("⚠️ JS Bridge が終了しました ({})。全サービスを停止します...", status);
            let _ = node_proc.kill();
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }

    println!("👋 すべてのプロセスを終了しました。");
    Ok(())
}

/* 
Dependency hint (Cargo.toml):
chrono = "0.4"
rand = "0.8"
*/