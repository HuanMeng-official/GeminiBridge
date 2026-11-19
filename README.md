# Gemini Bridge

把 Gemini 网页端包装成 OpenAI 兼容接口的本地桥接工具。它通过一个 MV3 浏览器扩展操作 Gemini 页面（发送消息、抓取回复、切换模型），再由本地 Node 网关把这一流程暴露成 `/v1/chat/completions`。

> 仅供本机个人使用。网关默认监听 `0.0.0.0` 且没有鉴权，不要暴露到公网或不可信网络。

## 功能

- OpenAI 兼容的 `GET /v1/models` 和 `POST /v1/chat/completions`
- 按 `model` 自动切换 Gemini 页面的模式选择器
- 支持 `system` / `developer` 提示词和多轮 `user` / `assistant` 历史
- 支持 OpenAI `tools` / `tool_choice` 的**模拟工具调用**（prompt 级，不支持流式）
- 每个 API 请求都使用全新的 **临时对话**，不写入 Gemini 历史列表
- 超长 prompt 自动分段发送（Gemini 输入框约 4000 字会截断）
- 多个请求自动串行，避免同时抢占输入框
- Gemini 页面右下角提供悬浮面板，可手动发送、查看回复和网关连接状态，支持深色模式

## 工作原理

```text
OpenAI 客户端
   │  HTTP 127.0.0.1:12306
   ▼
Node 网关 (gateway/src/gateway.js)
   │  WebSocket 127.0.0.1:8765
   ▼
浏览器扩展 Service Worker (bridge/background.js)
   │  chrome.tabs.sendMessage
   ▼
Content Script (bridge/content.js)
   │  DOM 操作
   ▼
https://gemini.google.com
```

扩展在 Gemini 页面注入 content script；网关收到 HTTP 请求后，通过 WebSocket 把 prompt 和模型信息发给扩展，扩展在页面上切换模型、填入内容、点击发送、等待回复完成，再把文本回传给网关。

## 环境要求

- Node.js 18+（推荐 22）
- Chrome 116+ 或 Edge 116+（MV3 扩展）
- 已登录的 Gemini 账号
- 使用期间保持一个 `https://gemini.google.com` 标签页打开

## 快速开始

### 1. 启动网关

```bash
cd gateway
npm install
npm start
```

看到下面两行说明启动成功：

```text
网关已启动，HTTP 端口: 12306，WS 端口: 8765
```

### 2. 加载扩展

- Chrome：打开 `chrome://extensions`
- Edge：打开 `edge://extensions`

开启“开发者模式”，选择“加载已解压的扩展程序”，指向本仓库的 `bridge/` 目录。

### 3. 打开 Gemini 页面

打开 `https://gemini.google.com` 并保持登录。扩展只在 Gemini 页面注入，其他页面不会工作。

### 4. 确认连接

网关终端出现：

```text
[WS] 插件已连接
```

说明扩展已经连上网关。扩展会优先使用当前激活的 Gemini 标签页；建议只开一个 Gemini 标签页。

### 5. 配置客户端

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:12306/v1` |
| API Key | 任意非空字符串，例如 `sk-local` |
| Model | 见下方模型表 |
| 流式输出 | 必须关闭（网关不支持 `stream: true`） |

## 客户端调用示例

### curl

```bash
curl http://127.0.0.1:12306/v1/models

curl http://127.0.0.1:12306/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-4-hydrogen",
    "messages": [
      {"role": "system", "content": "你是一个简洁的助手。"},
      {"role": "user", "content": "你好"}
    ]
  }'
```

Windows PowerShell 下建议使用 `curl.exe`，或直接用下面的 Python 示例。

### Python（OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:12306/v1",
    api_key="sk-local",
)

resp = client.chat.completions.create(
    model="gemini-4-hydrogen",
    messages=[
        {"role": "system", "content": "你是一个简洁的助手。"},
        {"role": "user", "content": "你好"},
    ],
    stream=False,
)

print(resp.choices[0].message.content)
```

## 模型

接口模型与 Gemini 页面「模式选择器」中的模式一一对应：

| `model` | 页面模式 | 页面模型 |
| --- | --- | --- |
| `gemini-4-hydrogen` | 日常帮助 | 4 Hydrogen |
| `gemini-4-neon` | 更深入的分析 | 4 Neon |
| `gemini-4-carbon` | 代码和复杂工作 | 4 Carbon |

- 传入上表中的 `model`：发送前会先把页面切到对应模式。
- 省略 `model`：沿用页面当前模式。
- 传入未知 `model`：不切换模式，响应里的 `model` 会原样回显传入值。
- 模型菜单文案随账号、语言和 Gemini 版本变化。若报错 `模式菜单里没有“xxx”`，按页面实际文案更新 `gateway/src/gateway.js` 里的 `MODELS`。
- 带锁模式（如 Carbon）会返回 `需要更高订阅，当前账号未解锁`。

## API 行为

### 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/models` | 返回 3 个模型 |
| `POST` | `/v1/chat/completions` | 非流式对话补全（含模拟工具调用） |

### messages 规则

- 支持的角色：`system`、`developer`、`user`、`assistant`、`tool`
- **最后一条消息必须是 `user`，或工具回传时的 `tool`**
- 只支持文本：`content` 为字符串，或 `[{ "type": "text", "text": "..." }]`
- 支持 `assistant.tool_calls` 和 `role: "tool"` 的工具结果回传
- 图片、音频会返回 400；不支持 `function` 角色
- 整个 prompt 上限 **60000 字符**
- `temperature`、`max_tokens`、`stream`、`parallel_tool_calls` 等参数会被忽略（仍可返回多个 tool call）

### system 与历史

Gemini 网页没有原生 system role，网关会把 system / developer 和历史消息序列化成一段文本：

```text
<system>
...
</system>

<conversation>
user: ...
assistant: ...
user: ...
</conversation>

请回答 <conversation> 中最后一条 user 消息。
```

只有一条 user、没有 system 且没有工具说明时，会直接发送原文，不加外壳。

### 工具调用（模拟）

网关支持 OpenAI 的 `tools` / `tool_choice`，但这是 **prompt 级模拟**，不是 Gemini 网页原生能力：

1. 请求带 `tools` 时，网关把工具名、描述、JSON Schema 和调用协议追加到 prompt 末尾。
2. 模型需要调用工具时输出：

```text
[[TOOL_CALL]]
{"name":"get_weather","arguments":{"city":"Paris"}}
[[END_TOOL_CALL]]
```

3. 网关解析后返回标准 OpenAI 格式：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_...",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"Paris\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

4. 客户端下一轮带上 `role: "tool"` 和 `tool_call_id`，网关会序列化成 `tool(call_...)` 行继续对话。

请求示例（`tool_choice: "required"` 会强制模型调用工具）：

```json
{
  "model": "gemini-4-hydrogen",
  "messages": [{ "role": "user", "content": "巴黎天气怎么样？" }],
  "tool_choice": "required",
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "查询天气",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  }]
}
```

`tool_choice` 支持 `auto`、`none`、`required` 和指定函数。模型返回非法 JSON、未知工具或不符合 `tool_choice` 时，网关返回 502。

限制：依赖模型遵循文本协议，复杂工具或多轮调用可能不稳定；只支持 function 工具和文本结果；工具定义计入 60000 字符上限，过长时仍会触发 3400 字分段；不支持流式工具调用。

### 临时对话

每个 API 请求都会创建一个全新的临时对话（Temporary chat）：

- 临时对话不会出现在 Gemini 左侧历史列表
- 请求之间上下文互相隔离
- 会重置网页上当前正在进行的对话，**不适合和手动使用 Gemini 同时进行**

如果页面找不到临时对话按钮，或无法创建空白临时会话，请求会明确失败，不会把内容发进旧对话。

### 长 prompt 分段

Gemini 网页输入框大约 4000 字会截断。超过 `MAX_INPUT_CHARS`（默认 3400）的 prompt 会被拆成多条消息发送：

- 前面的分段会加上 `【上下文分段 i/n，请只回复“继续”，不要回答或分析】` 前缀
- 最后一段才是真正的用户请求
- 只返回最后一段对应的回复
- 长 prompt 会产生多次模型调用，耗时明显增加

### 并发与超时

- 扩展内部用队列串行执行所有请求（手动 + API），不会同时操作输入框
- 网关等待回复的超时是 **300 秒**，超时返回 504 `生成超时`
- 并发请求会排队；排队时间也计入 300 秒

### 响应

标准 OpenAI 非流式响应。需要注意：

- `usage` 中的 token 数固定为 0
- `finish_reason` 固定为 `stop`
- 不支持流式（`stream: true` 会被忽略，返回普通 JSON）；客户端请关闭流式输出

## 常见问题

### 提示“插件未连接”

网关正常运行，但扩展没有连上 WebSocket。

1. 确认网关终端出现 `[WS] 插件已连接`
2. 在 `chrome://extensions` / `edge://extensions` 里点一次扩展的“重新加载”
3. 刷新 Gemini 页面
4. 确认没有启动第二个网关实例

网关重启后，扩展通常会在 30 秒内自动重连；切一次标签页也可以立即触发重连。

### 提示“找不到临时对话按钮”或“无法创建新的临时对话”

- 确认 Gemini 页面已登录，并且当前 UI 有“临时对话”入口
- 刷新 Gemini 页面后重试
- Gemini 前端改版后选择器可能失效，需要更新 `bridge/content.js` 中的临时对话按钮选择器

### 提示“文本注入不完整”

通常是输入框被提及菜单、模型菜单等浮层抢占焦点，或页面还没稳定。错误信息里会包含期望长度、实际长度、首末行状态和当前焦点，可据此判断。刷新页面后重试；如果稳定复现，检查 `bridge/content.js` 的 `fillEditor` / `insertLineByLine`。

### 提示“生成超时”

- 长 prompt 会被拆成多段，耗时可能超过 300 秒
- 减少历史消息或 system prompt 长度
- 确认 Gemini 页面没有卡在限流、验证码或错误提示

### `EADDRINUSE: address already in use :::8765` / `:::12306`

已经有一个网关实例在运行，或端口被其他程序占用：

```powershell
netstat -ano | findstr :12306
netstat -ano | findstr :8765
taskkill /PID <占用端口的PID> /F
```

然后重新 `npm start`。不要同时启动多个网关。

### 修改代码后不生效

- 改了 `bridge/` 下任何文件：到扩展管理页点“重新加载”，并刷新 Gemini 页面
- 改了 `gateway/` 下任何文件：重启 `npm start`
- 改了端口：需要同时修改 `gateway/src/gateway.js` 和 `bridge/background.js` 里的地址

## 配置项

| 配置 | 位置 | 默认值 |
| --- | --- | --- |
| HTTP 端口 | `gateway/src/gateway.js` | `12306` |
| WebSocket 端口 | `gateway/src/gateway.js`、`bridge/background.js` | `8765` |
| 模型清单 | `gateway/src/gateway.js` 的 `MODELS` | 见上表 |
| prompt 上限 | `gateway/src/prompt.js` 的 `MAX_PROMPT_CHARS` | `60000` |
| 单条输入上限 | `bridge/content.js` 的 `MAX_INPUT_CHARS` | `3400` |
| 生成超时 | `gateway/src/gateway.js` | `300000ms` |

## 测试

```bash
cd gateway
npm test
```

集成测试会在 `18765`（WebSocket）和 `12307`（HTTP）上启动临时网关，不影响正在运行的默认端口实例。

## 已知限制

- 不支持流式输出
- 工具调用是 prompt 模拟，不是原生 function calling，且不支持流式工具调用
- 不支持图片、音频等多模态输入
- 不会返回真实 token 用量
- 强依赖 Gemini 网页 DOM，Gemini 改版可能导致选择器失效
- 每次 API 请求会重置当前 Gemini 对话
- 需要 Gemini 账号和网页 UI 提供临时对话功能
- 单浏览器、单标签页串行工作；不适合高并发

## 安全说明

网关默认：

- HTTP 监听 `0.0.0.0:12306`
- WebSocket 监听所有网卡的 `8765`
- CORS 为 `*`
- 没有 API Key 校验

同一局域网内的任何人都可以调用它，并使用你登录的 Gemini 账号。仅在本机可信环境使用。如需收紧，可把 `gateway/src/gateway.js` 中的监听地址改为 `127.0.0.1`，并给 WebSocket Server 也加上 `host: '127.0.0.1'`。

## 项目结构

```text
GeminiBridge/
├── bridge/                 # Chrome/Edge MV3 扩展
│   ├── manifest.json
│   ├── background.js       # WebSocket 连接、请求转发
│   └── content.js          # 页面注入、模型切换、临时对话、输入/抓取
├── gateway/                # 本地 Node 网关
│   ├── src/
│   │   ├── gateway.js      # HTTP + WebSocket 服务
│   │   ├── prompt.js       # messages -> prompt 序列化
│   │   └── tools.js        # 工具协议、tool_calls 解析
│   ├── gateway.test.js
│   ├── prompt.test.js
│   ├── tools.test.js
│   ├── package.json
│   └── package-lock.json
├── LICENSE
└── README.md
```

## License

MIT，见 [LICENSE](LICENSE)。
