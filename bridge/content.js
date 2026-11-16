/**
 * Content Script
 * 在 Gemini 页面注入悬浮控制面板，并执行 DOM 抓取与发送指令。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * 填充文本到 Quill 编辑器，模拟真实按键输入
 * @param {string} text 要填入的文本
 */
async function fillEditor(text) {
  const editor = getVisibleEditor();
  if (!editor) throw new Error('找不到输入框');

  editor.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('delete', false);

  const ok = document.execCommand('insertText', false, text);
  if (!ok) throw new Error('文本注入失败');

  await sleep(150);
  if (editor.classList.contains('ql-blank') || !editor.innerText.trim()) {
    throw new Error('填充未生效');
  }
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
async function executePrompt(text, modeName, modeLabel) {
  await applyMode(modeName, modeLabel);
  const beforeCount = getResponseElements().length;
  await fillEditor(text);
  await clickSendWhenEnabled();
  const respEl = await waitForNewResponse(beforeCount);
  await waitForResponseDone(respEl);
  const content = extractText(respEl);
  if (!content) throw new Error('回复内容为空');
  return content;
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
        <span>Gemini Local Agent v1.1</span>
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
