/**
 * GLM Agent Chat —— DeepSeek-Harness 风格的网页 Agent 对话框
 *
 * 后端：纯 Node.js（零依赖），通过 GLM 开放平台 OpenAI 兼容接口调用 glm 模型，
 * 内置 Agent 工具循环（执行命令 / 读写文件），并以 SSE 向前端实时推送
 * 思考链（reasoning_content）、工具调用与最终回答。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'conversations.json');
const WORKSPACE_DIR = path.join(ROOT, 'workspace');

/* ---------------------------- 配置（.env） ---------------------------- */

function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnv();

const CONFIG = {
  port: parseInt(process.env.PORT || '3210', 10),
  apiKey: process.env.GLM_API_KEY || '',
  baseUrl: (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
  model: process.env.GLM_MODEL || 'glm-5.3',
  models: (process.env.GLM_MODELS || 'glm-5.3,glm-4.6,glm-4.5-air,glm-4.5-flash,glm-4-flash').split(',').map(s => s.trim()).filter(Boolean),
  maxSteps: parseInt(process.env.AGENT_MAX_STEPS || '8', 10),
  cmdTimeoutMs: parseInt(process.env.CMD_TIMEOUT_MS || '30000', 10),
  maxToolOutput: parseInt(process.env.MAX_TOOL_OUTPUT || '6000', 10),
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

/* ---------------------------- 会话存储 ---------------------------- */

const store = {
  data: {},
  _timer: null,
  load() {
    try {
      if (fs.existsSync(STORE_FILE)) this.data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch (e) {
      console.error('[store] 读取失败，使用空存储:', e.message);
    }
  },
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        fs.writeFileSync(STORE_FILE, JSON.stringify(this.data), 'utf8');
      } catch (e) {
        console.error('[store] 写入失败:', e.message);
      }
    }, 200);
  },
};

store.load();

function newConversation() {
  const id = crypto.randomUUID();
  const conv = { id, title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  store.data[id] = conv;
  store.save();
  return conv;
}

/* ---------------------------- 工具定义（harness） ---------------------------- */

/** 把用户/模型给的路径限制在 workspace 内，防止越界读写 */
function safeResolve(p) {
  const base = path.resolve(WORKSPACE_DIR);
  const target = path.resolve(base, p || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`路径越界：${p}（只允许访问工作区 ${base} 内的文件）`);
  }
  return target;
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n...[输出已截断，共 ${s.length} 字符]` : s;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在代理工作区（workspace 目录）中执行一条 shell 命令，例如查看目录、运行 python 脚本、git 操作等。返回命令的标准输出与标准错误。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取代理工作区中一个文本文件的内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区内的相对路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把文本内容写入代理工作区中的一个文件（覆盖写入）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区内的相对路径' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出代理工作区中一个目录的直接子项（文件/目录）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区内的相对路径，默认为根目录' },
        },
        required: [],
      },
    },
  },
];

function runCommand(command) {
  return new Promise((resolve) => {
    exec(command, { cwd: WORKSPACE_DIR, timeout: CONFIG.cmdTimeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let out = '';
      if (stdout) out += String(stdout);
      if (stderr) out += (out ? '\n[stderr]\n' : '') + String(stderr);
      if (err && err.killed) out += (out ? '\n' : '') + `[命令超时（>${CONFIG.cmdTimeoutMs / 1000}s）已被终止]`;
      else if (err && typeof err.code === 'number') out += (out ? '\n' : '') + `[退出码 ${err.code}]`;
      resolve(truncate(out || '(无输出)', CONFIG.maxToolOutput));
    });
  });
}

async function executeTool(name, args) {
  switch (name) {
    case 'run_command':
      return runCommand(args.command || '');
    case 'read_file': {
      const p = safeResolve(args.path);
      return truncate(fs.readFileSync(p, 'utf8'), CONFIG.maxToolOutput);
    }
    case 'write_file': {
      const p = safeResolve(args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(args.content ?? ''), 'utf8');
      return `已写入 ${args.path}（${String(args.content ?? '').length} 字符）`;
    }
    case 'list_dir': {
      const p = safeResolve(args.path);
      const items = fs.readdirSync(p, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name));
      return items.length ? items.join('\n') : '(空目录)';
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

/* ---------------------------- GLM 流式调用 ---------------------------- */

const SYSTEM_PROMPT = `你是一个运行在用户电脑上的智能 Agent（类似 DeepSeek Harness 的代理运行时），你的工作目录是 "${WORKSPACE_DIR}"。
你可以调用工具来完成任务：
- run_command：在工作区执行 shell 命令（查看文件、跑脚本、git 等）
- read_file / write_file / list_dir：管理工作区文件

使用原则：
1. 简单闲聊或知识问答直接回答，不必调用工具。
2. 涉及文件、命令、代码验证、数据处理等实际操作时，先思考计划，再调用工具，并根据工具结果继续或总结。
3. 工具输出可能被截断，注意甄别。
4. 默认使用中文回答。回答使用 Markdown 格式，代码用代码块包裹。

【需求不明确时必须澄清】
当用户的需求模糊、存在多种合理理解、或缺少关键参数时，不要猜测着直接动手。先输出一个选项卡片向用户提问，格式为（严格遵守，便于前端解析）：

\`\`\`options
{"question": "你的问题", "style": "single 或 multi", "options": ["选项A的描述", "选项B的描述", "选项C的描述"]}
\`\`\`

规则：
- 选项必须互斥、覆盖主要可能性，通常 2-4 个；style=multi 表示可多选。
- 输出选项卡片后立即停止，等待用户选择，不要自问自答。
- 需求已经明确时不要滥用此功能，直接执行。`;

const PLAN_PROMPT_SUFFIX = `

【规划模式（当前生效）】
你现在处于规划模式：只制定计划，绝不执行任何操作。
- 本次对话不提供任何工具，禁止尝试调用工具。
- 阅读用户需求后，产出一份清晰可执行的计划，计划主体必须放在一个 \`\`\`plan 代码块中，格式为 JSON：

\`\`\`plan
{"title": "计划标题", "goal": "一句话目标", "steps": [{"action": "步骤概述", "detail": "具体做法/涉及的命令或文件"}], "risks": ["风险与注意点"], "estimated": "预计用到的工具"}
\`\`\`

- 代码块之外可以有简短的开场说明，但计划内容必须完整、严格符合上述 JSON 结构（steps 至少 2 条， risks 可为空数组）。
- 如果需求本身不清楚，优先用 \`\`\`options 卡片向用户提问，而不是给出基于猜测的计划。`;

/**
 * 调 GLM chat/completions（stream），异步产出事件：
 *   {type:'reasoning', delta} {type:'content', delta} {type:'usage', usage}
 * 结束时返回 {finishReason, content, reasoning, toolCalls}
 */
async function streamCompletion(messages, tools, model, onEvent) {
  const body = {
    model,
    messages,
    stream: true,
    thinking: { type: 'enabled' },
    max_tokens: 8192,
  };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch {}
    const err = new Error(`GLM API ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }

  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let finishReason = null;
  const toolCalls = {}; // index -> {id, name, argsStr}

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.error) throw new Error(`GLM API: ${json.error.message || JSON.stringify(json.error)}`);
      const delta = json.choices?.[0]?.delta || {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onEvent({ type: 'reasoning', delta: delta.reasoning_content });
      }
      if (delta.content) {
        content += delta.content;
        onEvent({ type: 'content', delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', name: '', argsStr: '' };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].argsStr += tc.function.arguments;
        }
      }
      if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
      if (json.usage) onEvent({ type: 'usage', usage: json.usage });
    }
  }

  const calls = Object.keys(toolCalls).sort((a, b) => a - b).map((k) => {
    const tc = toolCalls[k];
    let args = {};
    try { args = tc.argsStr ? JSON.parse(tc.argsStr) : {}; } catch { args = { _raw: tc.argsStr }; }
    return { id: tc.id || crypto.randomUUID(), name: tc.name, args };
  });

  return { finishReason, content, reasoning, toolCalls: calls };
}

/* ---------------------------- Agent 循环（harness 核心） ---------------------------- */

/** 把存储中的会话消息转成 API 消息（去掉 reasoning，保留 tool_calls/tool 轮次） */
function toApiMessages(convMessages) {
  const out = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const m of convMessages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.tool_calls?.length) {
        msg.content = m.content || '';
        msg.tool_calls = m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool' && m.tool_call_id) {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    }
  }
  return out;
}

/**
 * 运行一次完整 Agent 对话循环。
 * onEvent 会收到（全部最终转发给前端 SSE）：
 *   reasoning / content / tool_call / tool_result / step / done / error
 */
async function runAgent(conv, userText, model, onEvent, isAborted, opts = {}) {
  const planMode = opts.mode === 'plan';
  const userMsg = { id: crypto.randomUUID(), role: 'user', content: userText, ts: Date.now() };
  conv.messages.push(userMsg);
  if (conv.messages.filter((m) => m.role === 'user').length === 1) {
    conv.title = userText.replace(/\s+/g, ' ').slice(0, 24) || '新对话';
  }

  const apiMessages = toApiMessages(conv.messages);
  if (planMode) apiMessages[0].content += PLAN_PROMPT_SUFFIX;
  const activeTools = planMode ? [] : TOOLS;

  for (let step = 0; step < (planMode ? 1 : CONFIG.maxSteps); step++) {
    if (isAborted && isAborted()) {
      const stopped = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '（已停止生成）',
        reasoning: '',
        tool_calls: [],
        ts: Date.now(),
      };
      conv.messages.push(stopped);
      store.save();
      onEvent({ type: 'done', message: stopped });
      return;
    }
    onEvent({ type: 'step', index: step + 1 });
    const r = await streamCompletion(apiMessages, activeTools, model, onEvent);

    const assistantMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: r.content,
      reasoning: r.reasoning,
      tool_calls: [],
      ts: Date.now(),
    };

    if (r.toolCalls.length && r.finishReason === 'tool_calls') {
      assistantMsg.tool_calls = r.toolCalls;
      conv.messages.push(assistantMsg);
      apiMessages.push({
        role: 'assistant',
        content: r.content || '',
        tool_calls: r.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });

      for (const call of r.toolCalls) {
        onEvent({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
        let ok = true;
        let output = '';
        try {
          output = await executeTool(call.name, call.args);
        } catch (e) {
          ok = false;
          output = `工具执行出错：${e.message}`;
        }
        onEvent({ type: 'tool_result', id: call.id, name: call.name, ok, output });
        const toolMsg = { id: crypto.randomUUID(), role: 'tool', tool_call_id: call.id, name: call.name, content: output, ok, ts: Date.now() };
        conv.messages.push(toolMsg);
        apiMessages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
      store.save();
      continue; // 进入下一轮，让模型基于工具结果继续
    }

    // 没有 tool_calls：普通回答，循环结束
    conv.messages.push(assistantMsg);
    store.save();
    onEvent({ type: 'done', message: assistantMsg });
    return;
  }

  // 达到步数上限，礼貌收尾
  const cut = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `（已达到单轮对话最大工具调用步数 ${CONFIG.maxSteps}，为避免循环消耗在此停止。可以让我继续，或换个说法再试。）`,
    reasoning: '',
    tool_calls: [],
    ts: Date.now(),
  };
  conv.messages.push(cut);
  store.save();
  onEvent({ type: 'done', message: cut });
}

/* ---------------------------- HTTP 服务 ---------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function publicConversation(conv) {
  return { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt, messages: conv.messages };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  /* ---------- API ---------- */
  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      model: CONFIG.model,
      models: CONFIG.models,
      hasKey: Boolean(CONFIG.apiKey),
      baseUrl: CONFIG.baseUrl,
      workspace: WORKSPACE_DIR,
      maxSteps: CONFIG.maxSteps,
    });
  }

  if (pathname === '/api/conversations' && req.method === 'GET') {
    const list = Object.values(store.data)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
    return sendJson(res, 200, list);
  }

  let m;
  if ((m = pathname.match(/^\/api\/conversations\/([\w-]+)$/))) {
    const conv = store.data[m[1]];
    if (!conv) return sendJson(res, 404, { error: '会话不存在' });
    if (req.method === 'GET') return sendJson(res, 200, publicConversation(conv));
    if (req.method === 'DELETE') {
      delete store.data[m[1]];
      store.save();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.title === 'string' && body.title.trim()) conv.title = body.title.trim().slice(0, 40);
      store.save();
      return sendJson(res, 200, publicConversation(conv));
    }
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    if (!CONFIG.apiKey) {
      return sendJson(res, 500, { error: '未配置 GLM_API_KEY，请在项目根目录 .env 中填写后重启服务' });
    }
    const body = await readBody(req);
    const userText = String(body.message || '').trim();
    if (!userText) return sendJson(res, 400, { error: '消息不能为空' });

    let conv = body.conversationId ? store.data[body.conversationId] : null;
    if (!conv) conv = newConversation();
    conv.updatedAt = Date.now();
    const model = CONFIG.models.includes(body.model) || body.model ? String(body.model || CONFIG.model) : CONFIG.model;
    const mode = body.mode === 'plan' ? 'plan' : 'chat';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    send({ type: 'conversation', id: conv.id, title: conv.title, model });

    let clientGone = false;
    req.on('close', () => { clientGone = true; });

    try {
      await runAgent(conv, userText, model, send, () => clientGone || res.writableEnded, { mode });
    } catch (e) {
      console.error('[agent] 出错:', e);
      send({ type: 'error', message: e.message || String(e) });
      // 失败时也要保证前端能收尾
      send({ type: 'done', message: { id: crypto.randomUUID(), role: 'assistant', content: '', reasoning: '', tool_calls: [], ts: Date.now(), error: e.message } });
    }
    res.end();
    return;
  }

  /* ---------- 静态文件 ---------- */
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(CONFIG.port, () => {
  console.log('┌──────────────────────────────────────────────');
  console.log('│  GLM Agent Chat（DeepSeek-Harness 风格）已启动');
  console.log(`│  地址      http://localhost:${CONFIG.port}`);
  console.log(`│  模型      ${CONFIG.model}`);
  console.log(`│  API       ${CONFIG.baseUrl}`);
  console.log(`│  API Key   ${CONFIG.apiKey ? '已配置' : '⚠ 未配置（请创建 .env 填写 GLM_API_KEY）'}`);
  console.log(`│  工作区    ${WORKSPACE_DIR}`);
  console.log('└──────────────────────────────────────────────');
});
