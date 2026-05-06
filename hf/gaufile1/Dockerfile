# Build stage for Go Proxy
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY main.go .
RUN go build -o proxy main.go

# Run stage (Python + Go)
FROM python:3.10-slim
WORKDIR /app

# Install system dependencies for llama-cpp-python if needed
RUN apt-get update && apt-get install -y build-essential curl && rm -rf /var/lib/apt/lists/*

# Copy Python requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Python App and Go Proxy
COPY app.py .
COPY --from=builder /app/proxy .

# Copy and prepare start script
COPY start.sh .
RUN chmod +x start.sh

# HF Spaces needs to listen on 7860
ENV PORT=7860
EXPOSE 7860

# Start both services
CMD ["./start.sh"]