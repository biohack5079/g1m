FROM python:3.9-slim

# 1. ビルドに必要なツールをrootでインストール
USER root
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    libopenblas-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# 2. ユーザー作成
RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH"

WORKDIR /app

# 3. 依存ライブラリのコピー
COPY --chown=user ./requirements.txt requirements.txt

# 4. llama-cpp-python のビルドとインストール
# -DLLAMA_BLAS=ON に対応させるため libopenblas-dev を上記で追加済み
# --verbose をつけることでビルドの進行状況をログで確認可能に
RUN CMAKE_ARGS="-DLLAMA_BLAS=ON -DLLAMA_BLAS_VENDOR=OpenBLAS" \
    CMAKE_BUILD_PARALLEL_LEVEL=1 \
    pip install --no-cache-dir --verbose -r requirements.txt

# 5. アプリケーションコードのコピー
COPY --chown=user . /app

# 6. ポート7860で起動
# タイムアウトを防ぐため --timeout-keep-alive を長めに設定
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--timeout-keep-alive", "60"]
