/**
 * OpenAI messages -> Gemini 网页端提示词
 *
 * 有 system/developer 或多轮历史时，序列化成固定的 <system>/<conversation> 结构；
 * 只有一条 user 且无 system 时保持原样，避免给简单请求加壳。
 */

const MAX_PROMPT_CHARS = 60000;
const SUPPORTED_ROLES = new Set(['system', 'developer', 'user', 'assistant']);

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

/**
 * 构建发送给 Gemini 的完整提示词。
 * @param {Array<{role: string, content: any}>} messages
 * @returns {string}
 */
function buildPrompt(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('messages 必须是数组');
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
  if (last.role !== 'user') {
    throw new Error('最后一条消息必须是 user');
  }

  const lastUserText = contentToText(last.content);
  if (!lastUserText.trim()) {
    throw new Error('未找到有效的用户消息');
  }

  const systemTexts = messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => contentToText(message.content))
    .filter((text) => text.trim() !== '');

  const history = messages
    .slice(0, -1)
    .filter((message) => message.role === 'user' || message.role === 'assistant');

  let prompt;

  if (systemTexts.length === 0 && history.length === 0) {
    prompt = lastUserText;
  } else {
    const lines = [];

    if (systemTexts.length > 0) {
      lines.push('<system>');
      lines.push(systemTexts.join('\n\n'));
      lines.push('</system>');
      lines.push('');
    }

    lines.push('<conversation>');
    for (const message of history) {
      lines.push(`${message.role}: ${contentToText(message.content)}`);
    }
    lines.push(`user: ${lastUserText}`);
    lines.push('</conversation>');
    lines.push('');
    lines.push('请回答 <conversation> 中最后一条 user 消息。');

    prompt = lines.join('\n');
  }

  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`上下文过长（${prompt.length} 字符，上限 ${MAX_PROMPT_CHARS}）`);
  }

  return prompt;
}

module.exports = { contentToText, buildPrompt, MAX_PROMPT_CHARS };
