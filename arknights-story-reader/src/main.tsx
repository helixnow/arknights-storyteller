import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// 全局错误处理
window.addEventListener('error', (event) => {
  console.error('[Global] 未捕获的错误:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global] 未处理的Promise拒绝:', event.reason);
});

// 启动日志只在开发构建里保留：生产环境的控制台留给真正的错误。
if (import.meta.env.DEV) {
  console.log('[Main] 应用启动');
  console.log('[Main] 环境:', import.meta.env.MODE);
  console.log('[Main] Tauri 可用:', "__TAURI__" in window);
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("[Main] 找不到 #root 挂载点");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
