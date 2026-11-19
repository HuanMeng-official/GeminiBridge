/**
 * 本地 AI 网关 (Node.js)
 * 接收 HTTP 请求，转换为 WebSocket 消息发送给浏览器插件。
 */
const http = require('http');
const WebSocket = require('ws');
const { buildPrompt } = require('./prompt');
const { normalizeTools, normalizeToolChoice, parseToolCalls } = require('./tools');

const WS_PORT = Number(process.env.GATEWAY_WS_PORT) || 8765;
const HTTP_PORT = Number(process.env.GATEWAY_HTTP_PORT) || 12306;
const pendingRequests = new Map();

/**
 * 与 Gemini 网页端「模式选择器」一一对应的模型清单。
 * 页面实际显示（2026-11 抓取）：
 *   日常帮助 → 4 Hydrogen
 *   更深入的分析 → 4 Neon
 *   代码和复杂工作 → 4 Carbon（带锁，需要更高订阅）
 *
 * name 是菜单项里的完整后缀，short 是选中后按钮上显示的简称（可能去掉版本号），
 * 用于切换后的校验。
 */
const MODELS = [
  { id: 'gemini-4-hydrogen', name: 'Hydrogen', short: 'Hydrogen', label: '日常帮助' },
  { id: 'gemini-4-neon', name: 'Neon', short: 'Neon', label: '更深入的分析' },
  { id: 'gemini-4-carbon', name: 'Carbon', short: 'Carbon', label: '代码和复杂工作' },
];
const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

const wss = new WebSocket.Server({ port: WS_PORT });
let extensionSocket = null;

wss.on('connection', (ws) => {
  if (!extensionSocket) {
    console.log('[WS] 插件已连接');
  }
  extensionSocket = ws;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      if (data.action === 'ping') {
        ws.send(JSON.stringify({ action: 'pong' }));
        return;
      }

      if (data.action === 'gemini_reply') {
        const { requestId, content, error } = data;
        const pending = pendingRequests.get(requestId);

        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(requestId);

          if (error) {
            console.error(`[HTTP] 请求 ${requestId} 失败: ${error}`);
            pending.res.writeHead(500, { 'Content-Type': 'application/json' });
            pending.res.end(JSON.stringify({ error: { message: error } }));
          } else {
            let parsed;
            try {
              parsed = parseToolCalls(content, {
                tools: pending.tools,
                toolChoice: pending.toolChoice,
              });
            } catch (parseError) {
              console.error(`[HTTP] 请求 ${requestId} 工具解析失败: ${parseError.message}`);
              pending.res.writeHead(502, { 'Content-Type': 'application/json' });
              pending.res.end(JSON.stringify({ error: { message: parseError.message } }));
              return;
            }

            console.log(
              `[HTTP] 请求 ${requestId} 成功 (${String(content || '').length} 字, ${parsed.toolCalls.length} 个工具调用)`,
            );

            const message = { role: 'assistant', content: parsed.content };
            if (parsed.toolCalls.length > 0) {
              message.tool_calls = parsed.toolCalls;
            }

            const responseBody = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: pending.model,
              choices: [{
                index: 0,
                message,
                finish_reason: parsed.toolCalls.length > 0 ? 'tool_calls' : 'stop'
              }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            };

            pending.res.writeHead(200, { 'Content-Type': 'application/json' });
            pending.res.end(JSON.stringify(responseBody));
          }
        }
      }
    } catch (e) {
      console.error('[WS] 消息解析失败:', e);
    }
  });

  ws.on('close', () => {
    if (extensionSocket === ws) {
      console.log('[WS] 插件已断开，等待重连...');
      extensionSocket = null;
    }
  });
});

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const pathname = req.url.split('?')[0];

  if (req.method === 'GET' && pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map((m) => ({
        id: m.id,
        object: 'model',
        created: 1735689600,
        owned_by: 'gemini-bridge',
        name: `${m.label} / ${m.name}`,
      })),
    }));
  }

  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const messages = Array.isArray(data.messages) ? data.messages : null;
        if (!messages) throw new Error('messages 必须是数组');

        const tools = normalizeTools(data.tools);
        const toolChoice = normalizeToolChoice(data.tool_choice, tools);

        // system/developer、多轮历史和工具说明在这里序列化成一段完整 prompt。
        const text = buildPrompt(messages, { tools, toolChoice });
        const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // 客户端传了页面里存在的模型 id 就切换模式；其余情况沿用页面当前模式。
        const requestedModel = typeof data.model === 'string' ? data.model.trim() : '';
        const model = MODEL_BY_ID.get(requestedModel) || null;
        const resolvedModelId = model ? model.id : (requestedModel || 'web-gemini-proxy');

        if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
          await new Promise(r => setTimeout(r, 1500));
          if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
            throw new Error('插件未连接');
          }
        }

        console.log(`[HTTP] 收到客户端请求: model=${resolvedModelId} prompt=${text.length} 字`);
        const timeout = setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '生成超时' } }));
          }
        }, 300000);

        pendingRequests.set(requestId, { res, timeout, model: resolvedModelId, tools, toolChoice });
        extensionSocket.send(JSON.stringify({
          action: 'ask_gemini',
          requestId,
          text,
          model: resolvedModelId,
          modeName: model ? model.name : null,
          modeLabel: model ? model.short : null,
        }));

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`网关已启动，HTTP 端口: ${HTTP_PORT}，WS 端口: ${WS_PORT}`);
});
