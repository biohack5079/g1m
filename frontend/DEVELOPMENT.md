# Frontend Development Guide

### WASM (WebAssembly) 開発環境のセットアップ
G1:Mのロボット制御ロジックはRustで記述され、WebAssemblyとしてビルドされます。wasm-pack ツールが必要です。

```bash
# rustup がインストールされていない場合
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# ツールとターゲットのインストール
cargo install wasm-pack
rustup target add wasm32-unknown-unknown
```

### 環境変数の設定

export PATH="$HOME/.cargo/bin:$PATH"
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

ルートディレクトリにある `start_g1m.sh` スクリプトが自動的に `wasm-pack build` を実行し、必要なWASMファイルを生成します。

### 依存関係のインストール

```bash
npm install
```
