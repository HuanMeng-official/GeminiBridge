const { randomUUID } = require('node:crypto');

const TOOL_CALL_START = '[[TOOL_CALL]]';
const TOOL_CALL_END = '[[END_TOOL_CALL]]';

function normalizeTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) throw new Error('tools 必须是数组');

  const seen = new Set();
  return tools.map((tool, index) => {
    if (!tool || tool.type !== 'function' || !tool.function || typeof tool.function !== 'object') {
      throw new Error(`tools[${index}] 不是有效的 function 工具`);
    }

    const name = typeof tool.function.name === 'string' ? tool.function.name.trim() : '';
    if (!name) throw new Error(`tools[${index}] 不是有效的 function 工具`);
    if (seen.has(name)) throw new Error(`工具名重复: ${name}`);
    seen.add(name);

    const parameters = tool.function.parameters === undefined || tool.function.parameters === null
      ? { type: 'object', properties: {} }
      : tool.function.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new Error(`工具 ${name} 的 parameters 必须是对象`);
    }

    return {
      name,
      description: typeof tool.function.description === 'string' ? tool.function.description : '',
      parameters,
    };
  });
}

function normalizeToolChoice(toolChoice, tools) {
  const list = Array.isArray(tools) ? tools : [];

  if (toolChoice === undefined || toolChoice === null || toolChoice === 'auto') {
    return { mode: 'auto' };
  }
  if (toolChoice === 'none') return { mode: 'none' };
  if (toolChoice === 'required') {
    if (list.length === 0) throw new Error('tool_choice 为 required 时需要至少一个工具');
    return { mode: 'required' };
  }

  if (typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function) {
    const name = typeof toolChoice.function.name === 'string' ? toolChoice.function.name.trim() : '';
    if (!name) throw new Error('tool_choice.function.name 不能为空');
    if (!list.some((tool) => tool.name === name)) {
      throw new Error(`tool_choice 指定了未知工具: ${name}`);
    }
    return { mode: 'function', name };
  }

  throw new Error('不支持的 tool_choice');
}

function renderToolInstructions(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  if (!toolChoice || toolChoice.mode === 'none') return '';

  const list = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  const lines = [
    '可用工具（JSON）：',
    JSON.stringify(list),
    '',
    '工具调用规则：',
    '- 需要调用工具时，只输出一个或多个如下格式的块，不要输出解释文字：',
    `  ${TOOL_CALL_START}`,
    '  {"name":"工具名","arguments":{...}}',
    `  ${TOOL_CALL_END}`,
    '- arguments 必须是合法的 JSON 对象。',
    '- 不需要调用工具时，直接用自然语言回答。',
    '- 历史中以 tool(...) 开头的行是已经执行过的工具结果，不要编造工具结果。',
  ];

  if (toolChoice.mode === 'required') {
    lines.push('- 本次必须调用至少一个工具，不能直接回答。');
  }
  if (toolChoice.mode === 'function') {
    lines.push(`- 本次必须调用工具 "${toolChoice.name}"，不要调用其他工具。`);
  }

  return lines.join('\n');
}

function stripCodeFence(value) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function parseJsonObject(value) {
  const text = stripCodeFence(value);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // fall through to the shared error below
      }
    }
    throw new Error('模型返回的工具调用不是合法 JSON');
  }
}

function normalizeArguments(value) {
  if (value === undefined || value === null) return '{}';

  if (typeof value === 'string') {
    const text = stripCodeFence(value);
    if (!text) return '{}';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('工具调用的 arguments 不是合法 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('工具调用的 arguments 必须是 JSON 对象');
    }
    return JSON.stringify(parsed);
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(value);
  }

  throw new Error('工具调用的 arguments 必须是 JSON 对象');
}

function parseToolCalls(text, { tools = [], toolChoice = { mode: 'auto' } } = {}) {
  const value = typeof text === 'string' ? text : '';

  if (!Array.isArray(tools) || tools.length === 0 || !toolChoice || toolChoice.mode === 'none') {
    return { content: value.trim() || null, toolCalls: [] };
  }

  const toolNames = new Set(tools.map((tool) => tool.name));
  const blocks = [];

  const markerRe = /\[\[TOOL_CALL\]\]\s*([\s\S]*?)\s*\[\[END_TOOL_CALL\]\]/gi;
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match;
  while ((match = markerRe.exec(value))) blocks.push(match[1]);
  while ((match = tagRe.exec(value))) blocks.push(match[1]);

  const content = value
    .replace(/\[\[TOOL_CALL\]\]\s*[\s\S]*?\s*\[\[END_TOOL_CALL\]\]/gi, '')
    .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '')
    .trim();

  if (blocks.length === 0) {
    if (toolChoice.mode === 'required' || toolChoice.mode === 'function') {
      throw new Error('模型没有按要求调用工具');
    }
    return { content: content || null, toolCalls: [] };
  }

  const toolCalls = blocks.map((block) => {
    const parsed = parseJsonObject(block);

    const fn = parsed && typeof parsed === 'object' && parsed.function && typeof parsed.function === 'object'
      ? parsed.function
      : parsed;
    const name = fn && typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) throw new Error('模型返回的工具调用缺少工具名');
    if (!toolNames.has(name)) throw new Error(`模型调用了未知工具: ${name}`);

    return {
      id: `call_${randomUUID().replace(/-/g, '')}`,
      type: 'function',
      function: {
        name,
        arguments: normalizeArguments(fn.arguments),
      },
    };
  });

  if (toolChoice.mode === 'function' && toolCalls.some((call) => call.function.name !== toolChoice.name)) {
    throw new Error(`本次必须调用工具 "${toolChoice.name}"`);
  }

  return { content: content || null, toolCalls };
}

module.exports = {
  normalizeTools,
  normalizeToolChoice,
  renderToolInstructions,
  parseToolCalls,
  TOOL_CALL_START,
  TOOL_CALL_END,
};
