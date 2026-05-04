🌐 G1:m — Human × AI × Robot Integration OS

G1:m is a Virtual–Real Integration Platform that connects human input, virtual representation, and physical robotic execution into a unified system.

Human Reality World (MediaPipe, mobile sensing, CNC biosignal sensors)
        ↕
G1:m Avatar Universe (Three.js, Unity, Plower AGI)
        ↕
Robotics Matrix World (G1:M, Unitree, Optimus)


G1:m functions as a Human Interface OS, absorbing differences between humans, avatars, and robots.

🎯 Design Concept

Unify human behavior, virtual environments, and robotics into a single interoperable layer

G1:m is not a single application, but a protocol-oriented system designed to:

Normalize human input

Synchronize virtual avatars

Execute actions in physical robotics

🧩 System Architecture
1. Human Reality Layer

MediaPipe (hand / pose tracking)

Camera input (PWA / mobile devices)

Motion data (MMD etc.)

👉 Captures real-world human intent and motion

2. Avatar Universe Layer

Three.js

Unity

👉 Provides simulation, visualization, and interaction

3. Robotics Matrix Layer

Kondo Kagaku KXR

Unitree robots

Tesla Optimus (future target)

👉 Executes physical actions based on abstracted commands

🔗 Modular Ecosystem

G1:m is designed as a core integration layer with modular applications:

🧠 Plower (Local LLM Module)

Plower is a local-first LLM application integrated into the G1:m ecosystem.

Privacy-focused document interaction

Local RAG workflows

Multi-model support (Gemma / GPT)

👉 Role in G1:m:

Local intelligence layer

On-device reasoning and memory

⚡ Cybernet Call (P2P Communication Module)

Cybernet Call is a WebRTC-based P2P communication system.

Direct peer-to-peer messaging

Low-latency data transfer

No centralized relay for real-time communication

👉 Role in G1:m:

Real-time coordination between human ↔ AI ↔ robot

Minimization of latency in control loops

🏗️ Infrastructure

Backend: Django / Node.js (modular integration)

Realtime: WebRTC (Cybernet Call)

Hosting: Render

Database / Auth: Supabase

Client: PWA (mobile-first)

👯 Avatar Meeting (Multi-user Sync Module)

Avatar Meeting is a multi-user communication system where participants interact via 3D avatars.

- Multi-peer VRM synchronization
- Motion tracking via MediaPipe Holistic
- Broadcast signaling for seamless entry/exit
- Extensible protocol for robot control integration

👉 Role in G1:m:

- Virtual meeting space for humans and AI
- Tele-presence interface for robot operation

⚖️ Design Principles
✔ Local-First Intelligence

Sensitive data processed locally (Plower)

Reduced dependency on cloud AI

✔ Low-Latency Communication

WebRTC-based P2P connections

Direct human ↔ system interaction

✔ Protocol-Oriented Design

G1:m is not a monolithic app

Acts as a connection standard between systems

✔ Practical Trade-offs

Accepts hardware limitations

Prioritizes stability over ideal features

Designed for incremental improvement

🚧 Current Challenges

MediaPipe ↔ Unity synchronization

Real-time coordinate alignment

Device variability (camera, performance)

P2P connection reliability (NAT traversal)

🚀 Future Directions

G1:m Protocol specification (v0.1)

Standardized motion/command format

Improved real-time synchronization

Robotics abstraction layer

Hybrid local + cloud intelligence optimization

🧠 Philosophy

G1:m is built on the idea that:

Human, AI, and machines should interoperate through transparent and neutral interfaces

It aims to avoid:

Centralized control

Black-box decision systems

Platform lock-in

And instead promote:

Interoperability

Transparency

Extensibility

🌏 Vision

The “Android OS” for Human–AI–Robot interaction

A system where:

Humans provide intent

AI interprets and optimizes

Robots execute in the real world

🛠️ Technologies

Django / Node.js

WebRTC

Render

Supabase

Unity

Three.js

MediaPipe

Local LLM (Plower)
---

## 環境変数の管理

ローカルでは、リポジトリに秘密情報を含めないために `.env` ファイルを使います。
`SUPABASE_URL`、`SUPABASE_KEY`、`LLM_API_URL` を設定し、`.env` は `.gitignore` に登録されています。

本番環境（Render / Hugging Face Spaces）では、サーバー管理画面の環境変数設定に同じキーを登録してください。

- ローカル: `.env`
- 本番: Render/Hugging Face の Environment Variables / Secrets

`.env.example` を用意しているので、`cp .env.example .env` して実際の値を入れてください。

For local testing and development using `ngrok`, please refer to [DEVELOPMENT.md](DEVELOPMENT.md).
