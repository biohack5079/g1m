# G1M Installer 開発ドキュメント

このプログラムは、Rust、Node.js、Ollama のセットアップ、および G1M プロジェクトのビルドと実行を Windows および Ubuntu 26.04 環境で自動化します。配布時はバイナリをプロジェクト直下の `dist` フォルダに配置します。

## ビルド方法

プロジェクトのルート、または `installer` ディレクトリで実行します。

念のため古いビルドをクリーン
cargo clean

```bash
cargo build --release
```

ビルド後、`target/release/` 内に実行ファイルが生成されます。

- **Windows**: `g1m-installer.exe`
- **Linux**: `g1m-installer`


## Windows での配布

Windows版では、実行ファイルと同じ階層にプロジェクト（`g1m-node`, `frontend`）がある状態で配布します。ユーザーが `.exe` をダブルクリックすると、以下のフローが実行されます。

1. HFトークンの入力（任意）
2. `winget` による Ollama の自動インストール（未検出時）
3. `gemma3:4b-it-q4_K_M` モデルのプル
4. Rust ノードとフロントエンドのビルド
5. サービスの起動

Ubuntu では、
dist/g1m-launcher として配置して

# バイナリに実行権限を付与
chmod +x dist/g1m-launcher

# 実行
./dist/g1m-launcher

# 停止

Ctrl + C

# g1m関連のプロセスをすべて強制終了
pkill -9 -f g1m-node
pkill -9 -f "node -e"
# ポートを無理やり解放
fuser -k 3000/tcp 4001/tcp


で実行してください。`apt-get` を使用して必要なツールを揃えるよう動作します。