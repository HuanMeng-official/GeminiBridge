/**
 * 本地 AI 网关 (Node.js)
 * 接收 HTTP 请求，转换为 WebSocket 消息发送给浏览器插件。
 */
const http = require('http');
const WebSocket = require('ws');

const WS_PORT = 8765;
const HTTP_PORT = 12306;
const pendingRequests = new Map();

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
            console.log(`[HTTP] 请求 ${requestId} 成功 (${content.length} 字)`);
            const responseBody = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'web-gemini-proxy',
              choices: [{
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop'
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
      data: [{
        id: 'web-gemini-proxy',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'gemini-bridge'
      }]
    }));
  }

  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const messages = data.messages || [];
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        
        if (!lastUserMsg || !lastUserMsg.content) {
          throw new Error('未找到有效的用户消息');
        }

        const text = lastUserMsg.content;
        const requestId = `req-${Date.now()}`;

        if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
          await new Promise(r => setTimeout(r, 1500));
          if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
            throw new Error('插件未连接');
          }
        }

        console.log(`[HTTP] 收到客户端请求: "${text.substring(0, 15)}..."`);
        const timeout = setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            res.writeHead(504);
            res.end(JSON.stringify({ error: { message: '生成超时' } }));
          }
        }, 180000);

        pendingRequests.set(requestId, { res, timeout });
        extensionSocket.send(JSON.stringify({ action: 'ask_gemini', requestId, text }));

      } catch (err) {
        res.writeHead(400);
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
