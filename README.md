## Gemini Bridge

把 Gemini 网页端包装成 OpenAI 兼容接口的本地桥接工具：

- `bridge/`：Chrome MV3 扩展，注入 Gemini 页面，负责点击“发送”并抓取回复
- `gateway/`：本地 Node 网关，提供 `http://127.0.0.1:12306/v1/*` 接口

### 使用

1. 在 `chrome://extensions` 打开“开发者模式”，选择“加载已解压的扩展程序”，指向 `bridge/` 目录。
   修改扩展代码后需要点刷新并刷新 Gemini 页面；悬浮面板标题会显示当前版本（如 v1.1）。
2. 启动网关：

```bash
cd gateway
npm install
npm start
```

1. 保持一个 Gemini 页面处于打开状态。
2. 调用接口：

```bash
curl http://127.0.0.1:12306/v1/models

curl http://127.0.0.1:12306/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-4-argon","messages":[{"role":"user","content":"你好"}]}'
```

### 模型

接口模型与 Gemini 页面「模式选择器」中的模式一一对应：

| `model` | 页面模式 | 页面模型 |
| --- | --- | --- |
| `gemini-3.5-flash-lite` | 快速解答 | 3.5 Flash-Lite |
| `gemini-4-hydrogen` | 日常帮助 | 4 Hydrogen |
| `gemini-3.1-pro` | 深度研究 | 3.1 Pro |
| `gemini-4-argon` | 代码与分析 | 4 Argon |
| `gemini-4-carbon` | 高难任务 | 4 Carbon（需要更高订阅，当前账号带锁） |

请求里的 `model` 命中上表时，会先把页面切换到对应模式再发送；传入未知模型或省略 `model` 时，沿用页面当前模式（响应中的 `model` 会原样回显）。
