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

const container = document.getElementById("root");
if (!container) {
  throw new Error("[Main] 找不到 #root 挂载点");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
