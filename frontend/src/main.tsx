import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// NOTE: StrictModeはuseEffectを開発時に2回発火させるため、
// Three.js/MediaPipe/WebRTCなど副作用の大きい処理と相性が悪い。
// GLBフェッチが中断される(DOMException: The operation was aborted)ため外している。
createRoot(document.getElementById('root')!).render(
  <App />,
)
