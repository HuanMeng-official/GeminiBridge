/**
 * Background Service Worker
 * 负责与本地网关建立 WebSocket 通信，并处理业务逻辑的转发。
 */
const WS_URL = 'ws://127.0.0.1:8765';
const HEARTBEAT_INTERVAL = 20 * 1000; 
const RECONNECT_DELAY = 2000;

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let isIntentionalClose = false;

/**
 * 初始化并连接 WebSocket
 */
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[Background] WebSocket 连接已恢复');
    startHeartbeat();
    chrome.alarms.create('ws-keep-alive', { periodInMinutes: 0.5 });
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.action === 'ping' || data.action === 'pong') return;
      if (data.action === 'ask_gemini') {
        await handleAskGemini(data);
      }
    } catch (err) {
      console.error('[Background] 消息解析异常:', err);
    }
  };

  ws.onclose = () => {
    stopHeartbeat();
    ws = null;
    if (!isIntentionalClose) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    // 忽略底层错误，由 onclose 统一处理重连
  };
}

/**
 * 启动心跳机制，维持 Service Worker 活跃
 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);
}

/**
 * 停止心跳
 */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 安排重连（静默执行，不刷屏日志）
 */
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, RECONNECT_DELAY);
}

/**
 * 处理网关发来的提问请求
 * @param {Object} data 包含 requestId 和 text 的数据对象
 */
async function handleAskGemini(data) {
  const { requestId, text, modeName, modeLabel } = data;
  const tabs = await chrome.tabs.query({ url: '*://gemini.google.com/*' });
  
  if (tabs.length === 0) {
    return sendWsResponse(requestId, null, '未找到打开的 Gemini 页面，请确保网页已打开。');
  }

  const targetTab = tabs.find(t => t.active) || tabs[0];

  chrome.tabs.sendMessage(targetTab.id, { type: 'EXTERNAL_SEND', text, modeName, modeLabel }, (response) => {
    if (chrome.runtime.lastError) {
      return sendWsResponse(requestId, null, `通信失败: ${chrome.runtime.lastError.message}`);
    }
    if (response && response.ok) {
      sendWsResponse(requestId, response.content, null);
    } else {
      sendWsResponse(requestId, null, response ? response.error : '网页端执行失败');
    }
  });
}

/**
 * 向网关回传结果
 */
function sendWsResponse(requestId, content, error) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: 'gemini_reply',
      requestId,
      content,
      error
    }));
  }
}

/**
 * 监听系统 Alarm，用于在 Service Worker 被强制休眠后重新唤醒
 * 注意：这个 Alarm 在脚本启动时就创建，不能只放在 ws.onopen 里，
 * 否则网关先没启动、插件始终连不上时，SW 休眠后将永远不再重试。
 */
chrome.alarms.get('ws-keep-alive', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('ws-keep-alive', { periodInMinutes: 0.5 });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ws-keep-alive') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
  }
});

/**
 * 标签页切换时检查连接状态
 */
chrome.tabs.onActivated.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }
});

connectWebSocket();
