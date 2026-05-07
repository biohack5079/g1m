# Stage 1: Go プロキシのビルド
FROM golang:1.21-bullseye AS go-builder
WORKDIR /app
COPY main.go .
RUN go build -o proxy main.go

# Stage 2: Python 実行環境の構築
FROM python:3.10-slim-bullseye

# システムパッケージのインストール (コンパイルが必要になった場合の備え)
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Go バイナリのコピー
COPY --from=go-builder /app/proxy .

# --- llama-cpp-python のビルド OOM 対策 ---
# 1. 並列コンパイル数を 1 に制限して RAM 使用量を最小化
ENV MAX_JOBS=1
# 2. ビルド済みバイナリ (wheel) がある場合は優先して使用
ENV PIP_PREFER_BINARY=1
# 3. キャッシュを使わずディスク容量を節約
ENV PIP_NO_CACHE_DIR=1

# 依存関係ファイルのコピー
COPY requirements.txt .

# pip のアップグレードと、CPU用ビルド済みホイールのリポジトリを指定してインストール
RUN pip install --upgrade pip && \
    pip install --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu -r requirements.txt

# アプリケーションファイルのコピー
COPY . .

# Hugging Face Spaces の実行環境 (UID 1000) への適合設定
RUN chmod +x start.sh proxy && \
    useradd -m -u 1000 user
USER user

CMD ["./start.sh"]