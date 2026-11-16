/**
 * Content Script
 * 在 Gemini 页面注入悬浮控制面板，并执行 DOM 抓取与发送指令。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Gemini 网页输入框对单条消息有前端截断（约 4000 字），
 * 超过这个长度的 prompt 必须拆成多条消息发送。
 */
const MAX_INPUT_CHARS = 3400;

/**
 * 轮询等待条件成立
 * @param {Function} fn 目标条件检查函数
 * @param {Object} options 包含 interval 和 timeout 的配置
 */
function waitFor(fn, { interval = 150, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let r;
      try { r = fn(); } catch (e) { clearInterval(timer); reject(e); return; }
      if (r) { clearInterval(timer); resolve(r); return; }
      if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error('等待超时')); }
    }, interval);
  });
}

function getVisibleEditor() {
  const list = [...document.querySelectorAll('div.ql-editor[contenteditable="true"]')];
  return list.find((el) => el.offsetParent !== null) || null;
}

function getSendButton() {
  return document.querySelector('button[aria-label="发送"]') || document.querySelector('button[aria-label="Send"]');
}

function getModeButton() {
  return document.querySelector('button[aria-label*="模式选择器"]');
}

/**
 * 把网页端模式切换到指定模型。
 * @param {string} modeName 菜单项里的完整后缀，如 “3.1 Pro”
 * @param {string} [modeLabel] 按钮上显示的简称，如 “Pro”；省略时从 modeName 推导
 */
async function applyMode(modeName, modeLabel) {
  if (!modeName) return;

  // 页面按钮只显示去掉版本号的简称，例如菜单里是 “3.1 Pro”，按钮上是 “Pro”。
  const display = modeLabel || modeName.replace(/^\d+(?:\.\d+)?\s+/, '');

  const current = getModeButton();
  if (!current) {
    console.warn('[GeminiBridge] 页面上找不到模式选择器，保持当前模式');
    return;
  }

  const label = current.getAttribute('aria-label') || '';
  if (label.includes(display) || label.includes(modeName)) return;

  const findItem = () => {
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    return items.find((el) => el.innerText.includes(modeName)) || null;
  };

  // 菜单可能已经处于展开状态（例如上一次请求出错），此时不要再点一次把它关掉。
  let item = findItem();
  if (!item) {
    current.click();
    item = await waitFor(findItem, { timeout: 5000 }).catch(() => null);
  }

  if (!item) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    throw new Error(`模式菜单里没有“${modeName}”`);
  }

  // 该项已经是选中状态时直接关闭菜单，避免重复点击后等不到任何变化。
  const selected = item.getAttribute('aria-checked') === 'true' ||
    item.textContent.includes('已选中') ||
    item.textContent.toLowerCase().includes('check');
  if (selected) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }

  const locked = item.textContent.toLowerCase().includes('lock') ||
    !!item.querySelector('[data-mat-icon-name="lock"], [aria-label="lock"], img[alt="lock"]');
  if (locked) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    throw new Error(`模型“${modeName}”需要更高订阅，当前账号未解锁`);
  }

  const beforeLabel = current.getAttribute('aria-label') || '';
  item.click();

  // 不同版本的前端按钮文案不同（“3.1 Pro” 可能显示成 “Pro”），
  // 因此只要按钮标签发生变化，或出现全名/简称，都视为切换成功。
  await waitFor(() => {
    const btn = getModeButton();
    if (!btn) return null;
    const next = btn.getAttribute('aria-label') || '';
    return (next !== beforeLabel || next.includes(display) || next.includes(modeName)) ? btn : null;
  }, { timeout: 8000 }).catch(() => {
    throw new Error(`切换到模型“${modeName}”失败`);
  });

  await sleep(200);
}

function getResponseElements() {
  return [...document.querySelectorAll('model-response-content')];
}

function getTempChatButton() {
  return document.querySelector('[data-test-id="temp-chat-button-container"] button') ||
    [...document.querySelectorAll('button')]
      .find((button) => /临时对话|temporary chat/i.test(button.getAttribute('aria-label') || '')) ||
    null;
}

function isTempChatOn() {
  const button = getTempChatButton();
  const label = button ? (button.getAttribute('aria-label') || '') : '';
  return /关闭临时对话|turn off temporary chat/i.test(label);
}

function getNewChatButton() {
  const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
  const matches = candidates.filter((el) => {
    const label = el.getAttribute('aria-label') || '';
    const text = `${label} ${el.innerText || ''}`;
    return /新对话|新建对话|new chat|new conversation/i.test(text) &&
      !/临时|temporary/i.test(text);
  });
  // 优先侧边栏的“发起新对话”（href=/app），避免点到 logo（href=/）触发整页刷新。
  return matches.find((el) => el.getAttribute('href') === '/app') || matches[0] || null;
}

function isFreshChat() {
  return getResponseElements().length === 0 && !!getVisibleEditor();
}

/**
 * 回到空白的新会话（不保证临时模式）。
 */
async function goHomeIfNeeded() {
  if (isFreshChat()) return;
  const newChat = getNewChatButton();
  if (!newChat) return;
  newChat.click();
  await waitFor(isFreshChat, { timeout: 10000 }).catch(() => {});
}

/**
 * 确保当前处于一个全新的临时对话。
 * 找不到临时对话按钮、或无法产生空白会话时抛出明确错误，绝不退回到旧对话发送。
 */
async function startFreshTempChat() {
  // 普通对话页可能没有临时对话按钮，先回首页。
  await goHomeIfNeeded();

  const tempButton = await waitFor(getTempChatButton, { timeout: 10000 }).catch(() => null);
  if (!tempButton) throw new Error('找不到临时对话按钮');

  if (!isTempChatOn()) {
    tempButton.click();
    await waitFor(isTempChatOn, { timeout: 8000 }).catch(() => {
      throw new Error('无法开启临时对话');
    });
  }

  // 临时模式可能要求从空白会话开始；仍在旧会话里就再点一次“新对话”。
  await goHomeIfNeeded();

  // 兜底：关掉临时对话再打开，强制产生新的临时会话。
  if (!isFreshChat()) {
    const off = getTempChatButton();
    if (off && isTempChatOn()) {
      off.click();
      await waitFor(() => !isTempChatOn(), { timeout: 8000 }).catch(() => {});
    }
    const on = getTempChatButton();
    if (on && !isTempChatOn()) {
      on.click();
      await waitFor(isTempChatOn, { timeout: 8000 }).catch(() => {});
    }
    await waitFor(isFreshChat, { timeout: 10000 }).catch(() => {});
  }

  if (!isFreshChat()) throw new Error('无法创建新的临时对话');
}

function getMarkdown(el) {
  return el.querySelector('div.markdown.markdown-main-panel');
}

function isResponseComplete(el) {
  const md = getMarkdown(el);
  return md ? md.getAttribute('aria-busy') === 'false' : false;
}

function extractText(el) {
  const md = getMarkdown(el);
  return md ? md.innerText.trim() : '';
}

function clearEditor(editor) {
  editor.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('delete', false);
}

function insertViaPaste(editor, text) {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  }));
}

function closeOverlays() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true,
  }));
}

async function insertLineByLine(text) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const editor = getVisibleEditor();
    if (!editor) return;

    // 输入过程中可能被提及菜单等浮层抢走焦点，逐行重新聚焦。
    if (document.activeElement !== editor) {
      closeOverlays();
      editor.focus();
    }

    if (index > 0) document.execCommand('insertLineBreak', false);
    if (lines[index]) document.execCommand('insertText', false, lines[index]);

    // “@” 会触发 Gemini 的提及菜单，插入后立刻关掉，避免影响后续内容。
    if (lines[index].includes('@')) {
      await sleep(10);
      closeOverlays();
      editor.focus();
    }

    if (index % 2 === 0) await sleep(8);
  }
}

async function getStableEditor(timeout = 3000) {
  const start = Date.now();
  let last = null;
  let since = 0;

  while (Date.now() - start < timeout) {
    const editor = getVisibleEditor();
    if (editor) {
      if (editor === last) {
        if (Date.now() - since >= 300) return editor;
      } else {
        last = editor;
        since = Date.now();
      }
    }
    await sleep(100);
  }

  return getVisibleEditor();
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function insertionState(editor, text) {
  const content = editor.innerText || '';
  const normalized = normalizeText(content);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const first = normalizeText(lines[0] || '');
  const last = normalizeText(lines[lines.length - 1] || '');
  const firstOk = !first || normalized.includes(first);
  const lastOk = !last || normalized.includes(last);

  return {
    ok: firstOk && lastOk,
    firstOk,
    lastOk,
    expected: text.length,
    actual: content.length,
  };
}

async function waitForInsertion(editor, text, timeout = 3000) {
  let state = insertionState(editor, text);
  try {
    await waitFor(() => {
      state = insertionState(editor, text);
      return state.ok ? true : null;
    }, { timeout, interval: 100 });
  } catch {
    // 超时后返回最后一次测量结果，由调用方决定是否回退。
  }
  return state;
}

function insertionDetails(editor, text) {
  const content = editor.innerText || '';
  const position = content.length;
  const tail = content.slice(-30).replace(/\n/g, '⏎');
  const next = text.slice(position, position + 30).replace(/\n/g, '⏎');
  const active = document.activeElement;
  const focus = active === editor ? '编辑器' : (active ? active.tagName : '无');

  return {
    actual: content.length,
    tail,
    next,
    focus,
    connected: editor.isConnected,
  };
}

/**
 * 填充文本到 Quill 编辑器
 * @param {string} text 要填入的文本
 */
async function fillEditor(text) {
  let editor = await getStableEditor();
  if (!editor) throw new Error('找不到输入框');

  clearEditor(editor);
  await sleep(50);
  editor = getVisibleEditor() || editor;

  // execCommand('insertText') 遇到换行只会插入第一行；优先派发 paste 事件，
  // 让 Quill 按自己的剪贴板逻辑把多行文本解析成段落。
  insertViaPaste(editor, text);

  const pasteState = await waitForInsertion(editor, text, 1200);
  let finalState = pasteState;

  if (!pasteState.ok) {
    editor = getVisibleEditor() || editor;
    clearEditor(editor);
    await sleep(50);
    await insertLineByLine(text);
    editor = getVisibleEditor() || editor;
    finalState = await waitForInsertion(editor, text, 5000);
  }

  if (!finalState.ok) {
    const details = insertionDetails(editor, text);
    throw new Error(
      `文本注入不完整（期望 ${finalState.expected} 字，实际 ${finalState.actual} 字` +
      `，首行${finalState.firstOk ? 'OK' : '缺失'}，末行${finalState.lastOk ? 'OK' : '缺失'}` +
      `；粘贴后 ${pasteState.actual} 字；末尾=${details.tail}` +
      `；后续=${details.next}；焦点=${details.focus}；连接=${details.connected}）`,
    );
  }
}

/**
 * 把长 prompt 按行拆成多条消息，避免触发 Gemini 输入框的前端截断。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitPrompt(text, maxChars = MAX_INPUT_CHARS) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      chunks.push(buffer);
      buffer = '';
    }
  };

  for (const line of text.split('\n')) {
    const candidate = buffer ? `${buffer}\n${line}` : line;

    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }

    flush();

    let rest = line;
    while (rest.length > maxChars) {
      chunks.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    buffer = rest;
  }

  flush();
  return chunks;
}

/**
 * 等待发送按钮可用并点击
 */
async function clickSendWhenEnabled() {
  const btn = await waitFor(() => {
    const b = getSendButton();
    return (b && b.getAttribute('aria-disabled') !== 'true') ? b : null;
  }, { timeout: 8000 });
  btn.click();
}

/**
 * 等待新的 AI 回复元素出现
 * @param {number} prevCount 之前的回复元素数量
 */
async function waitForNewResponse(prevCount, timeout = 45000) {
  return waitFor(() => {
    const els = getResponseElements();
    return els.length > prevCount ? els[els.length - 1] : null;
  }, { timeout });
}

/**
 * 等待 AI 回复生成完毕（双重容错机制）
 * @param {Element} el 目标回复元素
 */
async function waitForResponseDone(el, timeout = 180000) {
  await waitFor(() => isResponseComplete(el), { timeout, interval: 300 });
  let lastText = '';
  for (let i = 0; i < 25; i++) {
    const currentText = extractText(el);
    if (currentText && currentText === lastText) break;
    lastText = currentText;
    await sleep(400);
  }
}

/**
 * 核心执行入口
 * @param {string} text 发送的提示词
 * @param {string} [modeName] 可选的模式名，先切换模式再发送
 * @param {string} [modeLabel] 模式按钮上的简称
 */
async function executePromptNow(text, modeName, modeLabel) {
  await startFreshTempChat();
  await applyMode(modeName, modeLabel);

  const chunks = splitPrompt(text);
  let content = '';

  for (let index = 0; index < chunks.length; index++) {
    const isLast = index === chunks.length - 1;
    // 中间分段只投喂上下文，避免模型对半截内容长篇作答。
    const piece = isLast
      ? chunks[index]
      : `【上下文分段 ${index + 1}/${chunks.length}，请只回复“继续”，不要回答或分析】\n\n${chunks[index]}`;

    const beforeCount = getResponseElements().length;
    await fillEditor(piece);
    await clickSendWhenEnabled();
    const respEl = await waitForNewResponse(beforeCount);
    await waitForResponseDone(respEl);

    if (isLast) content = extractText(respEl);
  }

  if (!content) throw new Error('回复内容为空');
  return content;
}

// 所有请求串行执行，避免多个客户端同时抢占输入框。
let executionQueue = Promise.resolve();

function executePrompt(text, modeName, modeLabel) {
  const run = executionQueue.then(() => executePromptNow(text, modeName, modeLabel));
  executionQueue = run.catch(() => {});
  return run;
}

/**
 * 注入 UI 悬浮窗并绑定事件
 */
function injectFloatingUI() {
  if (document.getElementById('gemini-mv3-float-host')) return;

  const host = document.createElement('div');
  host.id = 'gemini-mv3-float-host';
  host.style.cssText = 'position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .panel { position: fixed; bottom: 100px; right: 40px; width: 320px; background: #fff; border: 1px solid #dadce0; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); font-family: system-ui, sans-serif; display: flex; flex-direction: column; transition: 0.2s; }
      .panel.hidden { opacity: 0; pointer-events: none; transform: translateY(20px); }
      .header { padding: 10px 14px; background: #f8f9fa; font-weight: 600; cursor: move; display: flex; justify-content: space-between; border-bottom: 1px solid #dadce0; color: #3c4043; user-select: none; border-radius: 12px 12px 0 0; }
      .close-btn { background: none; border: none; cursor: pointer; color: #5f6368; font-size: 16px; }
      .content { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
      textarea { width: 100%; height: 70px; resize: none; padding: 8px; border: 1px solid #dadce0; border-radius: 6px; font-family: inherit; }
      textarea:focus { outline: none; border-color: #1a73e8; }
      .btn-row { display: flex; justify-content: flex-end; }
      button.send-btn { background: #1a73e8; color: #fff; border: none; padding: 6px 16px; border-radius: 6px; cursor: pointer; }
      button.send-btn:disabled { background: #9aa0a6; cursor: not-allowed; }
      .status { font-size: 12px; color: #5f6368; min-height: 16px; }
      .reply-box { max-height: 200px; overflow-y: auto; background: #f8f9fa; border: 1px solid #dadce0; padding: 8px; border-radius: 6px; font-size: 13px; white-space: pre-wrap; display: none; }
      .reply-box.visible { display: block; }
      .fab { position: fixed; bottom: 100px; right: 40px; width: 48px; height: 48px; border-radius: 50%; background: #1a73e8; color: #fff; display: none; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2); border: none; font-weight: bold; }
      .fab.visible { display: flex; }
    </style>
    <button class="fab" id="fab">AI</button>
    <div class="panel" id="panel">
      <div class="header" id="drag-header">
        <span>Gemini Bridge</span>
        <button class="close-btn" id="close-btn">✖</button>
      </div>
      <div class="content">
        <textarea id="input" placeholder="等待外部指令或手动输入..."></textarea>
        <div class="btn-row"><button class="send-btn" id="send-btn">发送</button></div>
        <div class="status" id="status"></div>
        <div class="reply-box" id="reply"></div>
      </div>
    </div>
  `;

  const panel = shadow.getElementById('panel');
  const fab = shadow.getElementById('fab');
  const inputEl = shadow.getElementById('input');
  const sendBtn = shadow.getElementById('send-btn');
  const statusEl = shadow.getElementById('status');
  const replyEl = shadow.getElementById('reply');
  const header = shadow.getElementById('drag-header');

  shadow.getElementById('close-btn').addEventListener('click', () => {
    panel.classList.add('hidden'); fab.classList.add('visible');
  });
  
  fab.addEventListener('click', () => {
    fab.classList.remove('visible'); panel.classList.remove('hidden');
  });

  sendBtn.addEventListener('click', async () => {
    const text = inputEl.value.trim();
    if (!text || sendBtn.disabled) return;

    replyEl.classList.remove('visible');
    statusEl.textContent = '正在执行...';
    sendBtn.disabled = true; inputEl.disabled = true;

    try {
      const result = await executePrompt(text);
      statusEl.textContent = '完成';
      replyEl.textContent = result;
      replyEl.classList.add('visible');
    } catch (e) {
      statusEl.textContent = `失败: ${e.message}`;
    } finally {
      sendBtn.disabled = false; inputEl.disabled = false;
    }
  });

  let isDragging = false, startX, startY, startLeft, startTop;
  header.addEventListener('mousedown', (e) => {
    isDragging = true; startX = e.clientX; startY = e.clientY;
    const rect = panel.getBoundingClientRect(); startLeft = rect.left; startTop = rect.top;
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const newLeft = Math.max(0, Math.min(startLeft + e.clientX - startX, window.innerWidth - panel.offsetWidth));
    const newTop = Math.max(0, Math.min(startTop + e.clientY - startY, window.innerHeight - panel.offsetHeight));
    panel.style.left = newLeft + 'px'; panel.style.top = newTop + 'px';
    panel.style.bottom = 'auto'; panel.style.right = 'auto';
  });
  
  document.addEventListener('mouseup', () => { isDragging = false; });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'EXTERNAL_SEND') {
      panel.classList.remove('hidden'); fab.classList.remove('visible');
      inputEl.value = msg.text;
      statusEl.textContent = '收到外部请求，正在执行...';
      sendBtn.disabled = true; inputEl.disabled = true;

      executePrompt(msg.text, msg.modeName, msg.modeLabel)
        .then(result => {
          statusEl.textContent = '请求处理完成';
          replyEl.textContent = result; replyEl.classList.add('visible');
          sendResponse({ ok: true, content: result });
        })
        .catch(err => {
          statusEl.textContent = `请求处理失败: ${err.message}`;
          sendResponse({ ok: false, error: err.message });
        })
        .finally(() => {
          sendBtn.disabled = false; inputEl.disabled = false;
        });

      return true;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectFloatingUI);
} else {
  injectFloatingUI();
}
