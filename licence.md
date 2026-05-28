# License Summary for G1M

This document provides a comprehensive review of all third-party software and libraries used in G1M, verifying their licenses for distribution readiness (e.g., via `sudo apt install g1m`).

## Summary of License Compliance
- **No GPL/AGPL dependencies detected**: All libraries are licensed under permissive open-source licenses such as MIT, Apache 2.0, and BSD.
- **Distribution Readiness**: Since there are no copyleft/GPL/AGPL requirements, the codebase can be packaged and distributed freely (e.g., via Debian/Ubuntu package repositories).

---

## 1. Backend Dependencies (`package.json` & Rust/Go reference)

| Dependency | Purpose | License | Copyleft |
| :--- | :--- | :--- | :--- |
| **@mediapipe/hands** | Hand landmark tracking | Apache 2.0 | No |
| **@mediapipe/pose** | Pose landmark tracking | Apache 2.0 | No |
| **concurrently** | Multi-process development environment execution | MIT | No |
| **dotenv** | Environment configuration loader | BSD-2-Clause | No |
| **express** | Local HTTP server framework | MIT | No |
| **socket.io** | Signaling communication (WebSocket) | MIT | No |
| **undici** | Fast HTTP client for proxying LLM requests | MIT | No |
| **gorilla/websocket** | Reference Go WebSocket library | BSD-2-Clause | No |
| **modernc.org/sqlite** | Reference Go SQLite wrapper | BSD-3-Clause | No |

---

## 2. Frontend Dependencies (`frontend/package.json`)

| Dependency | Purpose | License | Copyleft |
| :--- | :--- | :--- | :--- |
| **@mediapipe/camera_utils** | Camera capture pipeline | Apache 2.0 | No |
| **@mediapipe/drawing_utils** | Wireframe/landmark rendering | Apache 2.0 | No |
| **@mediapipe/holistic** | Full face, body, and hand tracking | Apache 2.0 | No |
| **@pixiv/three-vrm** | Three.js VRM 3D Avatar loader/handler | MIT | No |
| **three** | WebGL 3D Rendering engine | MIT | No |
| **react** | Frontend application framework | MIT | No |
| **react-dom** | React DOM renderer | MIT | No |
| **socket.io-client** | WebRTC signaling client | MIT | No |
| **kalidokit** | Kinematics solver for 3D avatars | MIT | No |

---

## 3. Rust P2P Nodes & DePIN Clustering Dependencies (New Addition)

| Crate | Purpose | License | Copyleft |
| :--- | :--- | :--- | :--- |
| **libp2p** | Peer-to-peer signaling & network communication | MIT / Apache 2.0 | No |
| **tokio** | Async runtime | MIT | No |
| **axum / warp** | Local control APIs & frontend proxy | MIT | No |
| **sqlx / rusqlite** | SQLite database driver & sync | MIT | No |
| **serde / serde_json** | Data serialization | MIT / Apache 2.0 | No |

---

## 4. Action Plan for Packaging (`sudo apt install g1m`)

To package G1M into a `.deb` file for apt installation:
1. **Debian Control File**: Prepare `debian/control` defining package metadata, setting architecture to `any`, and defining dependencies (`rustc`, `cargo`, `sqlite3`).
2. **Post-Installation Scripts**: Use `postinst` scripts to set up user configurations, register systemd daemons for the P2P synchronization backend, and initialize the SQLite database directory in `/var/lib/g1m` or `~/.config/g1m`.
3. **Execution binary**: Compile the Rust P2P node and signaling agent to `/usr/bin/g1m-node`.
