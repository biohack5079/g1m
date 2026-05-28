# Stage 1: Build the React + TypeScript frontend
FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY package*.json ./
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Stage 2: Build the Rust P2P backend
FROM rust:1.78-slim AS backend-builder
WORKDIR /app
# Install system build dependencies
RUN apt-get update && apt-get install -y pkg-config libssl-dev git && rm -rf /var/lib/apt/lists/*
COPY g1m-node/ ./g1m-node/
RUN cd g1m-node && cargo build --release

# Stage 3: Final lightweight runtime container
FROM debian:bookworm-slim
WORKDIR /app

# Install runtime dependencies (OpenSSL, SQLite, CA Certificates)
RUN apt-get update && apt-get install -y \
    openssl \
    ca-certificates \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Copy the compiled Rust binary
COPY --from=backend-builder /app/g1m-node/target/release/g1m-node /usr/local/bin/g1m-node

# Copy the frontend built assets
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Expose HTTP port
EXPOSE 3000

# Set default env variables
ENV PORT=3000
ENV P2P_PORT=4001
ENV RUST_LOG=info

# Run the Rust server
CMD ["/usr/local/bin/g1m-node"]
