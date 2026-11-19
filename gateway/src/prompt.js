/**
 * OpenAI messages -> Gemini 网页端提示词
 *
 * 有 system/developer、多轮历史或工具说明时，序列化成固定的
 * <system>/<conversation> 结构；只有一条 user 且无附加内容时保持原样。
 */
const { renderToolInstructions } = require('./tools');

const MAX_PROMPT_CHARS = 60000;
const SUPPORTED_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

/**
 * 把 OpenAI 的 content 转成纯文本。
 * @param {string|Array<{type: string, text?: string}>} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object' || part.type !== 'text') {
        throw new Error('暂不支持非文本内容（图片等）');
      }
      parts.push(typeof part.text === 'string' ? part.text : '');
    }
    return parts.join('\n');
  }

  throw new Error('暂不支持非文本内容（图片等）');
}

function formatToolCall(call, index) {
  if (!call || typeof call !== 'object') {
    throw new Error(`assistant.tool_calls[${index}] 格式无效`);
  }

  const id = typeof call.id === 'string' ? call.id.trim() : '';
  if (!id) throw new Error(`assistant.tool_calls[${index}] 缺少 id`);

  const fn = call.function;
  if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) {
    throw new Error(`assistant.tool_calls[${index}] 缺少 function.name`);
  }

  let args = '{}';
  if (typeof fn.arguments === 'string') {
    args = fn.arguments.trim() || '{}';
  } else if (fn.arguments && typeof fn.arguments === 'object') {
    args = JSON.stringify(fn.arguments);
  }

  return `assistant: [tool_call ${id}] ${fn.name.trim()}(${args})`;
}

/**
 * 构建发送给 Gemini 的完整提示词。
 * @param {Array<{role: string, content: any}>} messages
 * @param {{tools?: Array, toolChoice?: {mode: string, name?: string}}} options
 * @returns {string}
 */
function buildPrompt(messages, { tools = [], toolChoice = { mode: 'auto' } } = {}) {
  if (!Array.isArray(messages)) {
    throw new Error('messages 必须是数组');
  }
  if (!Array.isArray(tools)) {
    throw new Error('tools 必须是数组');
  }

  for (const message of messages) {
    if (!message || typeof message.role !== 'string') {
      throw new Error('每条消息都必须包含字符串 role');
    }
    if (!SUPPORTED_ROLES.has(message.role)) {
      throw new Error(`不支持的消息角色: ${message.role}`);
    }
  }

  const last = messages[messages.length - 1];
  if (!last) {
    throw new Error('未找到有效的用户消息');
  }
  if (last.role !== 'user' && last.role !== 'tool') {
    throw new Error('最后一条消息必须是 user 或 tool');
  }
  if (!messages.some((message) => message.role === 'user')) {
    throw new Error('未找到有效的用户消息');
  }

  let lastUserText = '';
  if (last.role === 'user') {
    lastUserText = contentToText(last.content);
    if (!lastUserText.trim()) {
      throw new Error('未找到有效的用户消息');
    }
  }

  const systemTexts = messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => contentToText(message.content))
    .filter((text) => text.trim() !== '');

  const dialogue = messages.filter(
    (message) => message.role !== 'system' && message.role !== 'developer',
  );
  const lines = [];

  for (const message of dialogue) {
    if (message.role === 'user') {
      lines.push(`user: ${contentToText(message.content)}`);
      continue;
    }

    if (message.role === 'assistant') {
      let added = false;

      if (message.content !== undefined && message.content !== null) {
        const text = contentToText(message.content);
        if (text.trim()) {
          lines.push(`assistant: ${text}`);
          added = true;
        }
      }

      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) {
          throw new Error('assistant.tool_calls 必须是数组');
        }
        message.tool_calls.forEach((call, index) => {
          lines.push(formatToolCall(call, index));
          added = true;
        });
      }

      if (!added) {
        throw new Error('assistant 消息既没有 content 也没有 tool_calls');
      }
      continue;
    }

    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id.trim()) {
        throw new Error('tool 消息必须包含 tool_call_id');
      }
      lines.push(`tool(${message.tool_call_id.trim()}): ${contentToText(message.content)}`);
    }
  }

  const toolSection = renderToolInstructions(tools, toolChoice);
  const needsWrapper = systemTexts.length > 0 || dialogue.length > 1 || Boolean(toolSection);

  if (!needsWrapper) {
    if (lastUserText.length > MAX_PROMPT_CHARS) {
      throw new Error(`上下文过长（${lastUserText.length} 字符，上限 ${MAX_PROMPT_CHARS}）`);
    }
    return lastUserText;
  }

  const chunks = [];

  if (systemTexts.length > 0) {
    chunks.push(`<system>\n${systemTexts.join('\n\n')}\n</system>`);
    chunks.push('');
  }

  chunks.push('<conversation>');
  chunks.push(...lines);
  chunks.push('</conversation>');
  chunks.push('');

  if (last.role === 'tool') {
    chunks.push('请根据 <conversation> 中最后一条 user 消息和工具结果继续回答；如需更多工具，按规则调用。');
  } else {
    chunks.push('请回答 <conversation> 中最后一条 user 消息。');
  }

  if (toolSection) {
    chunks.push('');
    chunks.push(toolSection);
  }

  const prompt = chunks.join('\n');
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`上下文过长（${prompt.length} 字符，上限 ${MAX_PROMPT_CHARS}）`);
  }
  return prompt;
}

module.exports = { contentToText, buildPrompt, MAX_PROMPT_CHARS };
