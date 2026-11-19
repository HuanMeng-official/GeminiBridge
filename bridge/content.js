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
 * @param {string} modeName 菜单项里的完整后缀
 * @param {string} [modeLabel] 按钮上显示的简称；省略时从 modeName 推导
 */
async function applyMode(modeName, modeLabel) {
  if (!modeName) return;

  // 页面按钮可能只显示去掉版本号的简称，因此按全名或简称匹配都算切换成功。
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

  // 不同版本的前端按钮文案可能不同，只要按钮标签发生变化，
  // 或出现全名/简称，都视为切换成功。
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
      .panel, .fab {
        --gb-font: "Google Sans", "Roboto", "Segoe UI", system-ui, -apple-system, sans-serif;
        --gb-surface: #ffffff;
        --gb-surface-muted: #f6f8fb;
        --gb-surface-inset: #eef2f7;
        --gb-text: #1f1f1f;
        --gb-text-2: #5f6368;
        --gb-text-3: #80868b;
        --gb-border: rgba(60, 64, 67, 0.12);
        --gb-border-strong: rgba(60, 64, 67, 0.2);
        --gb-accent: #1a73e8;
        --gb-accent-hover: #1765cc;
        --gb-accent-soft: rgba(26, 115, 232, 0.1);
        --gb-on-accent: #ffffff;
        --gb-success: #188038;
        --gb-danger: #d93025;
        --gb-ring: rgba(26, 115, 232, 0.3);
        --gb-shadow: 0 0 0 1px rgba(60, 64, 67, 0.06), 0 12px 32px rgba(60, 64, 67, 0.18), 0 2px 8px rgba(60, 64, 67, 0.08);
        --gb-fab-shadow: 0 0 0 1px rgba(60, 64, 67, 0.06), 0 6px 18px rgba(60, 64, 67, 0.16);
        box-sizing: border-box;
        font-family: var(--gb-font);
        color: var(--gb-text);
      }
      .panel[data-theme="dark"], .fab[data-theme="dark"] {
        --gb-surface: #1e1f20;
        --gb-surface-muted: #26282a;
        --gb-surface-inset: #2b2d2f;
        --gb-text: #e8eaed;
        --gb-text-2: #a8abaf;
        --gb-text-3: #8e9297;
        --gb-border: rgba(255, 255, 255, 0.1);
        --gb-border-strong: rgba(255, 255, 255, 0.18);
        --gb-accent: #8ab4f8;
        --gb-accent-hover: #aecbfa;
        --gb-accent-soft: rgba(138, 180, 248, 0.14);
        --gb-on-accent: #062e6f;
        --gb-success: #81c995;
        --gb-danger: #f28b82;
        --gb-ring: rgba(138, 180, 248, 0.35);
        --gb-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 18px 44px rgba(0, 0, 0, 0.55);
        --gb-fab-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 8px 22px rgba(0, 0, 0, 0.45);
      }
      .panel {
        position: fixed;
        right: 32px;
        bottom: 96px;
        width: 360px;
        max-width: calc(100vw - 24px);
        background: var(--gb-surface);
        border-radius: 18px;
        box-shadow: var(--gb-shadow);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        visibility: visible;
        opacity: 1;
        transform: translateY(0) scale(1);
        transform-origin: bottom right;
        transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s;
        z-index: 2147483647;
      }
      .panel.hidden {
        visibility: hidden;
        opacity: 0;
        transform: translateY(8px) scale(0.98);
        pointer-events: none;
        transition: opacity 140ms cubic-bezier(0.23, 1, 0.32, 1), transform 140ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s linear 140ms;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 11px 12px 11px 14px;
        background: var(--gb-surface);
        border-bottom: 1px solid var(--gb-border);
        cursor: grab;
        user-select: none;
      }
      .panel.dragging .header { cursor: grabbing; }
      .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .brand-icon {
        width: 30px;
        height: 30px;
        border-radius: 9px;
        background: var(--gb-accent-soft);
        color: var(--gb-accent);
        display: grid;
        place-items: center;
        flex: 0 0 auto;
      }
      .brand-icon svg { width: 18px; height: 18px; display: block; }
      .brand-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .brand-title { font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.2; }
      .brand-sub { font-size: 11px; font-weight: 500; color: var(--gb-text-3); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .header-actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
      .conn-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 999px;
        background: var(--gb-surface-muted);
        border: 1px solid var(--gb-border);
        font-size: 11px;
        font-weight: 500;
        color: var(--gb-text-2);
        white-space: nowrap;
      }
      .conn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gb-text-3); flex: 0 0 auto; }
      .conn-pill[data-state="online"] .conn-dot { background: var(--gb-success); }
      .conn-pill[data-state="offline"] .conn-dot { background: var(--gb-danger); }
      .icon-btn {
        position: relative;
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 9px;
        background: transparent;
        color: var(--gb-text-2);
        display: grid;
        place-items: center;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease, transform 120ms ease;
      }
      .icon-btn::after { content: ""; position: absolute; inset: -4px; }
      .icon-btn:hover { background: var(--gb-surface-muted); color: var(--gb-text); }
      .icon-btn:active { transform: scale(0.96); }
      .icon-btn svg { width: 18px; height: 18px; }
      .body { padding: 14px; display: flex; flex-direction: column; gap: 8px; }
      textarea {
        width: 100%;
        min-height: 84px;
        max-height: 180px;
        resize: none;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid transparent;
        background: var(--gb-surface-inset);
        color: var(--gb-text);
        font-family: var(--gb-font);
        font-size: 13px;
        line-height: 1.55;
        outline: none;
        transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
        scrollbar-width: thin;
        scrollbar-color: var(--gb-border-strong) transparent;
      }
      textarea::placeholder { color: var(--gb-text-3); }
      textarea:focus { border-color: var(--gb-accent); box-shadow: 0 0 0 3px var(--gb-ring); background: var(--gb-surface); }
      textarea:disabled { opacity: 0.65; cursor: not-allowed; }
      .meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 0 2px; font-size: 11px; color: var(--gb-text-3); }
      .meta .count { font-variant-numeric: tabular-nums; }
      .meta .hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .send-btn {
        height: 40px;
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 0;
        border-radius: 12px;
        background: var(--gb-accent);
        color: var(--gb-on-accent);
        font-family: var(--gb-font);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 120ms ease, transform 120ms ease, opacity 120ms ease;
      }
      .send-btn svg { width: 16px; height: 16px; }
      .send-btn:hover:not(:disabled) { background: var(--gb-accent-hover); }
      .send-btn:active:not(:disabled) { transform: scale(0.98); }
      .send-btn:disabled { background: var(--gb-surface-inset); color: var(--gb-text-3); cursor: not-allowed; opacity: 0.85; }
      .status {
        min-height: 16px;
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 11.5px;
        color: var(--gb-text-3);
        padding: 1px 2px;
      }
      .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gb-text-3); flex: 0 0 auto; }
      .status[data-tone="success"] .status-dot { background: var(--gb-success); }
      .status[data-tone="error"] .status-dot { background: var(--gb-danger); }
      .status[data-tone="error"] { color: var(--gb-danger); }
      .status[data-tone="busy"] { color: var(--gb-text-2); }
      .status[data-tone="busy"] .status-dot { display: none; }
      .status-spinner {
        display: none;
        width: 12px;
        height: 12px;
        flex: 0 0 auto;
        border: 2px solid var(--gb-border-strong);
        border-top-color: var(--gb-accent);
        border-radius: 50%;
        animation: gb-spin 0.8s linear infinite;
      }
      .status[data-tone="busy"] .status-spinner { display: inline-block; }
      @keyframes gb-spin { to { transform: rotate(360deg); } }
      .reply {
        display: none;
        flex-direction: column;
        gap: 8px;
        margin-top: 2px;
        padding: 10px 12px;
        background: var(--gb-surface-muted);
        border: 1px solid var(--gb-border);
        border-radius: 12px;
      }
      .reply.visible { display: flex; }
      .reply-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 600; color: var(--gb-text-3); letter-spacing: 0.02em; }
      .copy-btn {
        border: 0;
        background: transparent;
        color: var(--gb-text-2);
        font-family: var(--gb-font);
        font-size: 11px;
        font-weight: 500;
        padding: 3px 6px;
        border-radius: 6px;
        cursor: pointer;
      }
      .copy-btn:hover { background: var(--gb-surface-inset); color: var(--gb-text); }
      .reply-body {
        max-height: 220px;
        overflow-y: auto;
        font-size: 12.5px;
        line-height: 1.6;
        color: var(--gb-text);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        text-wrap: pretty;
        scrollbar-width: thin;
        scrollbar-color: var(--gb-border-strong) transparent;
      }
      .fab {
        position: fixed;
        right: 32px;
        bottom: 96px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--gb-surface);
        color: var(--gb-accent);
        border: 0;
        box-shadow: var(--gb-fab-shadow);
        cursor: pointer;
        visibility: hidden;
        opacity: 0;
        pointer-events: none;
        transform: scale(0.94);
        transition: opacity 140ms cubic-bezier(0.23, 1, 0.32, 1), transform 140ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s linear 140ms;
        z-index: 2147483647;
      }
      .fab.visible {
        visibility: visible;
        opacity: 1;
        pointer-events: auto;
        transform: scale(1);
        transition: opacity 140ms cubic-bezier(0.23, 1, 0.32, 1), transform 140ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s;
      }
      .fab:hover { transform: scale(1.04); }
      .fab:active { transform: scale(0.96); }
      .fab svg { width: 22px; height: 22px; }
      .fab-dot {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--gb-text-3);
        border: 2px solid var(--gb-surface);
        box-sizing: content-box;
      }
      .fab-dot[data-state="online"] { background: var(--gb-success); }
      .fab-dot[data-state="offline"] { background: var(--gb-danger); }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }
      button:focus-visible, textarea:focus-visible { outline: 2px solid var(--gb-accent); outline-offset: 2px; }
      textarea:focus-visible { outline: none; }
      @media (prefers-reduced-motion: reduce) {
        .panel, .panel.hidden, .fab, .fab.visible, .send-btn, .icon-btn { transition: none; }
        .status-spinner { animation: none; }
      }
    </style>
    <button class="fab" id="fab" type="button" aria-label="打开 Gemini Bridge 面板">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 15.5h16"/>
        <path d="M6.5 15.5V9a5.5 5.5 0 0 1 11 0v6.5"/>
        <circle cx="6.5" cy="18" r="1.6" fill="currentColor" stroke="none"/>
        <circle cx="17.5" cy="18" r="1.6" fill="currentColor" stroke="none"/>
      </svg>
      <span class="fab-dot" id="fab-dot" data-state="offline"></span>
    </button>
    <div class="panel" id="panel" role="region" aria-label="Gemini Bridge 控制台">
      <header class="header" id="drag-header">
        <div class="brand">
          <span class="brand-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 15.5h16"/>
              <path d="M6.5 15.5V9a5.5 5.5 0 0 1 11 0v6.5"/>
              <circle cx="6.5" cy="18" r="1.6" fill="currentColor" stroke="none"/>
              <circle cx="17.5" cy="18" r="1.6" fill="currentColor" stroke="none"/>
            </svg>
          </span>
          <span class="brand-text">
            <span class="brand-title">Gemini Bridge</span>
            <span class="brand-sub">本地网关控制台</span>
          </span>
        </div>
        <div class="header-actions">
          <span class="conn-pill" id="conn-pill" data-state="offline" title="网关连接状态">
            <span class="conn-dot" aria-hidden="true"></span>
            <span id="conn-text">未连接</span>
          </span>
          <button class="icon-btn" id="close-btn" type="button" aria-label="收起面板">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 10l6 6 6-6"/>
            </svg>
          </button>
        </div>
      </header>
      <div class="body">
        <label class="sr-only" for="input">指令</label>
        <textarea id="input" rows="3" placeholder="输入指令，或等待外部请求…"></textarea>
        <div class="meta">
          <span class="count" id="char-count">0 字</span>
          <span class="hint">Ctrl / ⌘ + Enter 发送</span>
        </div>
        <button class="send-btn" id="send-btn" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6"/>
          </svg>
          <span>发送</span>
        </button>
        <div class="status" id="status" data-tone="muted" aria-live="polite">
          <span class="status-spinner" aria-hidden="true"></span>
          <span class="status-dot" aria-hidden="true"></span>
          <span id="status-text">等待指令</span>
        </div>
        <section class="reply" id="reply-card" aria-label="最近回复">
          <div class="reply-head">
            <span>最近回复</span>
            <button class="copy-btn" id="copy-btn" type="button">复制</button>
          </div>
          <div class="reply-body" id="reply"></div>
        </section>
      </div>
    </div>
  `;

  const panel = shadow.getElementById('panel');
  const fab = shadow.getElementById('fab');
  const fabDot = shadow.getElementById('fab-dot');
  const inputEl = shadow.getElementById('input');
  const sendBtn = shadow.getElementById('send-btn');
  const statusEl = shadow.getElementById('status');
  const statusText = shadow.getElementById('status-text');
  const replyCard = shadow.getElementById('reply-card');
  const replyEl = shadow.getElementById('reply');
  const copyBtn = shadow.getElementById('copy-btn');
  const header = shadow.getElementById('drag-header');
  const connPill = shadow.getElementById('conn-pill');
  const connText = shadow.getElementById('conn-text');
  const charCount = shadow.getElementById('char-count');
  const closeBtn = shadow.getElementById('close-btn');

  let activeRequests = 0;

  function updateCharCount() {
    charCount.textContent = `${inputEl.value.length} 字`;
  }

  function setStatus(text, tone = 'muted') {
    statusText.textContent = text;
    statusEl.dataset.tone = tone;
  }

  function setBusy(busy) {
    activeRequests = Math.max(0, activeRequests + (busy ? 1 : -1));
    const isBusy = activeRequests > 0;
    sendBtn.disabled = isBusy;
    inputEl.disabled = isBusy;
    sendBtn.querySelector('span').textContent = isBusy ? '执行中…' : '发送';
    panel.classList.toggle('busy', isBusy);
  }

  function showReply(text) {
    replyEl.textContent = text;
    replyCard.classList.add('visible');
    replyEl.scrollTop = 0;
  }

  function hideReply() {
    replyCard.classList.remove('visible');
    replyEl.textContent = '';
  }

  function openPanel() {
    panel.classList.remove('hidden');
    fab.classList.remove('visible');
  }

  function closePanel() {
    panel.classList.add('hidden');
    fab.classList.add('visible');
  }

  function setConnection(connected) {
    const state = connected ? 'online' : 'offline';
    connPill.dataset.state = state;
    fabDot.dataset.state = state;
    connText.textContent = connected ? '已连接' : '未连接';
  }

  function refreshConnection() {
    try {
      chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (res) => {
        if (chrome.runtime.lastError) {
          setConnection(false);
          return;
        }
        setConnection(Boolean(res && res.connected));
      });
    } catch {
      setConnection(false);
    }
  }

  function detectPageTheme() {
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      const match = getComputedStyle(node).backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (!match) continue;
      const [r, g, b, a = 1] = match[1].split(',').map((value) => parseFloat(value));
      if (a === 0) continue;
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return luminance < 0.45 ? 'dark' : 'light';
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = detectPageTheme();
    panel.dataset.theme = theme;
    fab.dataset.theme = theme;
  }

  closeBtn.addEventListener('click', closePanel);

  fab.addEventListener('click', () => {
    openPanel();
    refreshConnection();
  });

  inputEl.addEventListener('input', updateCharCount);

  inputEl.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendBtn.click();
    }
  });

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing) closePanel();
  });

  copyBtn.addEventListener('click', async () => {
    const text = replyEl.innerText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    copyBtn.textContent = '已复制';
    setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
  });

  sendBtn.addEventListener('click', async () => {
    const text = inputEl.value.trim();
    if (!text || sendBtn.disabled) return;

    hideReply();
    setStatus('正在执行…', 'busy');
    setBusy(true);

    try {
      const result = await executePrompt(text);
      setStatus('完成', 'success');
      showReply(result);
      refreshConnection();
    } catch (error) {
      setStatus(`失败：${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  });

  let isDragging = false, startX, startY, startLeft, startTop;
  header.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) return;
    isDragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    panel.classList.add('dragging');
    event.preventDefault();
  });

  document.addEventListener('mousemove', (event) => {
    if (!isDragging) return;
    const newLeft = Math.max(0, Math.min(startLeft + event.clientX - startX, window.innerWidth - panel.offsetWidth));
    const newTop = Math.max(0, Math.min(startTop + event.clientY - startY, window.innerHeight - panel.offsetHeight));
    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
    panel.style.bottom = 'auto';
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    panel.classList.remove('dragging');
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'EXTERNAL_SEND') {
      openPanel();
      inputEl.value = msg.text;
      updateCharCount();
      hideReply();
      setStatus('收到外部请求，正在执行…', 'busy');
      setBusy(true);
      setConnection(true);

      executePrompt(msg.text, msg.modeName, msg.modeLabel)
        .then((result) => {
          setStatus('请求完成', 'success');
          showReply(result);
          refreshConnection();
          sendResponse({ ok: true, content: result });
        })
        .catch((err) => {
          setStatus(`请求失败：${err.message}`, 'error');
          sendResponse({ ok: false, error: err.message });
        })
        .finally(() => {
          setBusy(false);
        });

      return true;
    }
  });

  updateCharCount();
  applyTheme();
  refreshConnection();
  setInterval(applyTheme, 3000);
  setInterval(refreshConnection, 4000);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectFloatingUI);
} else {
  injectFloatingUI();
}
