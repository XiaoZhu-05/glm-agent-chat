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
const tls = require('tls');
const zlib = require('zlib');
const { exec, execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// DATA_DIR 可被环境变量覆盖，单测用它与会话存储隔离
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
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
  models: (process.env.GLM_MODELS || 'glm-5.3,glm-4.6,glm-4.5-air,glm-4.5-flash,glm-4-flash,glm-4v-flash').split(',').map(s => s.trim()).filter(Boolean),
  visionModels: (process.env.GLM_VISION_MODELS || 'glm-4v-flash,glm-4.5v,glm-4.6v').split(',').map(s => s.trim()).filter(Boolean),
  imageMaxBytes: parseInt(process.env.IMAGE_MAX_BYTES || String(5 * 1024 * 1024), 10),
  maxImagesPerMessage: parseInt(process.env.MAX_IMAGES_PER_MESSAGE || '4', 10),
  uploadMaxBytes: parseInt(process.env.UPLOAD_MAX_BYTES || String(10 * 1024 * 1024), 10),
  pdfMaxPages: parseInt(process.env.PDF_MAX_PAGES || '30', 10),
  xlsxMaxRows: parseInt(process.env.XLSX_MAX_ROWS || '200', 10),
  maxAttachmentChars: parseInt(process.env.MAX_ATTACHMENT_CHARS || '8000', 10),
  pythonBin: process.env.PYTHON_BIN || 'python',
  contextWindowMessages: parseInt(process.env.CONTEXT_WINDOW_MESSAGES || '40', 10),
  maxTokens: parseInt(process.env.GLM_MAX_TOKENS || '8192', 10),
  // 各模型 max_tokens 上限不同（如 glm-4v-flash 上限 1024），未列出的用全局默认
  maxTokensByModel: { 'glm-4v-flash': 1024 },
  // GLM 流式响应空闲超时：超过该时长未收到任何 chunk 视为连接挂死，主动中断，
  // 避免上游/API 代理中途断流导致服务端与前端互相等待、界面永久转圈
  streamIdleTimeoutMs: parseInt(process.env.GLM_STREAM_IDLE_TIMEOUT_MS || '90000', 10),
  // BioNeMo（NVIDIA NIM 云端 ESMFold）
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  nimBaseUrl: (process.env.NIM_BASE_URL || 'https://health.api.nvidia.com/v1/biology/nvidia/esmfold').replace(/\/+$/, ''),
  nimTimeoutMs: parseInt(process.env.NIM_TIMEOUT_MS || '120000', 10),
  // Biomni（子 agent，独立 venv 子进程）
  biomniPython: process.env.BIOMNI_PYTHON || '',
  biomniModel: process.env.BIOMNI_MODEL || 'glm-4.5-flash',
  biomniTimeoutMs: parseInt(process.env.BIOMNI_TIMEOUT_MS || '300000', 10),
  // EveryInfra（数据采集/搜索平台 API）
  everyinfraApiKey: process.env.EVERYINFRA_API_KEY || '',
  everyinfraBaseUrl: (process.env.EVERYINFRA_BASE_URL || 'https://api.everyinfra.com').replace(/\/+$/, ''),
  everyinfraTimeoutMs: parseInt(process.env.EVERYINFRA_TIMEOUT_MS || '120000', 10), // 官方同步窗口约 100s
  everyinfraJobMaxWaitMs: parseInt(process.env.EVERYINFRA_JOB_MAX_WAIT_MS || '120000', 10),
  everyinfraProxy: process.env.EVERYINFRA_PROXY || '',
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
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索公开网络信息。当问题涉及最新动态、版本号、时事、价格、资料出处等模型训练数据可能过时或缺失的内容时使用；返回带链接的搜索结果，回答时必须以 Markdown 链接引用来源。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（中英文均可，必要时拆成多个关键词）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'protein_structure',
      description: '蛋白质三维结构预测（NVIDIA BioNeMo ESMFold，NIM 云端服务）。输入单字母氨基酸序列，返回预测的三级结构并保存为 PDB 文件到工作区。适合「预测蛋白结构 / 建模 / 折叠」类请求；序列上限 1024 个氨基酸；会自动去除 FASTA 的 > 注释行与空白。',
      parameters: {
        type: 'object',
        properties: {
          sequence: { type: 'string', description: '氨基酸单字母序列，如 MVHLTPEEKSAVTALWGKVNVDEVGGEALGRLLVVYPWTQRFF（可直接粘贴含 > 注释行的 FASTA）' },
        },
        required: ['sequence'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'biomni_task',
      description: '调用 Biomni 生物医学研究子 agent（Stanford 出品，30+ 生物工具域：基因组/蛋白/文献检索/数据库查询等）执行复杂的多步研究任务。注意：Biomni 会自主规划并执行 Python 代码，单次任务可能耗时 2-5 分钟，结果可能不收敛；适合深度生物信息学分析，简单的序列计算或文件处理直接用 run_command 即可。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '交给 Biomni 的完整任务描述（含输入数据与期望输出，中文或英文）' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'everyinfra_data',
      description: '调用 EveryInfra 数据平台 API：① 采集 90 个平台的公开数据（小红书/抖音/B站/知乎/微博/淘宝/TikTok/YouTube/Reddit 等，动作如 search/profile/note/comments/trending）；② 17 种联网搜索工具（web/news/scholar/semantic/crawl/read/crosscheck 等）。首次使用先用 kind=catalog 查平台与动作清单（免 key）；social/search 是付费调用（约 ¥0.005~0.04/次），仅在用户明确要求数据采集时使用，不要为试探而调用。结果自动保存完整 JSON 到工作区 everyinfra/ 目录并返回预览，支持 next_page_token 翻页与异步任务轮询。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['catalog', 'social', 'search', 'job'], description: 'catalog=查平台/动作/搜索工具目录（免 key）；social=平台数据采集；search=搜索工具；job=查询异步任务结果' },
          platform: { type: 'string', description: '平台名（kind=social 必填，如 xiaohongshu/douyin/bilibili/reddit；kind=catalog 可选，传入则返回该平台的动作与计价）' },
          action: { type: 'string', description: '数据动作（kind=social 必填，如 search/profile/note/comments/trending，以 catalog 查询结果为准）' },
          tool: { type: 'string', description: '搜索工具名（kind=search 必填，如 web/news/scholar/semantic/read/crawl）' },
          job_id: { type: 'string', description: '异步任务 ID（kind=job 必填）' },
          mode: { type: 'string', enum: ['sync', 'async'], description: '执行模式（可选）：sync=同步等待结果（默认，慢任务可能接近 100s）；async=立即返回 job_id 后台执行，本工具自动轮询至完成' },
          params: { type: 'object', description: '接口参数对象，按 catalog 查询结果填写（如 social 搜索常为 {"keyword":"关键词"}、search 工具常为 {"q":"关键词"}）；翻页时传 {"page_token":"上次响应的 next_page_token"}' },
        },
        required: ['kind'],
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
    case 'web_search':
      return webSearch(args.query || '');
    case 'protein_structure':
      return predictProteinStructure(args.sequence || '');
    case 'biomni_task':
      return runBiomniTask(String(args.task || ''));
    case 'everyinfra_data':
      return everyinfraData(args || {});
    default:
      throw new Error(`未知工具：${name}`);
  }
}

/* ---------------------------- 文档解析（上传附件） ---------------------------- */

const TOOLS_DIR = path.join(ROOT, 'tools');
const UPLOAD_ALLOWED_EXT = ['.pdf', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json', '.fasta', '.fa', '.fas'];
const FASTA_EXT = ['.fasta', '.fa', '.fas'];

function runPython(script, args) {
  return new Promise((resolve) => {
    execFile(CONFIG.pythonBin, [script, ...args], { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const hint = /ENOENT|not found|无法找到/i.test(String(err.message))
          ? '（未找到 Python，请安装 Python 或在 .env 中配置 PYTHON_BIN）'
          : '';
        resolve({ ok: false, error: `文档解析失败${hint}：${String(stderr || err.message).slice(0, 200)}` });
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop()));
      } catch {
        resolve({ ok: false, error: '文档解析输出异常，请确认文件未损坏' });
      }
    });
  });
}

/** FASTA 原生解析：序列数 / 每条 ID、长度、GC 含量 */
function parseFasta(text) {
  const seqs = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('>')) {
      if (cur) seqs.push(cur);
      const header = line.slice(1).trim();
      cur = { id: header.split(/\s+/)[0] || '(无ID)', desc: header, seq: '' };
    } else if (line.trim() && cur) {
      cur.seq += line.replace(/\s+/g, '').toUpperCase();
    }
  }
  if (cur) seqs.push(cur);
  const stats = seqs.map((s) => {
    const gc = (s.seq.match(/[GC]/g) || []).length;
    return { id: s.id, length: s.seq.length, gc: s.seq.length ? ((gc / s.seq.length) * 100).toFixed(1) + '%' : '0%' };
  });
  return { count: seqs.length, stats, seqs };
}

/** 根据扩展名解析上传文件，返回统一结构 {ok, kind, summary, text, warning?, error?} */
async function extractDocument(savedPath, name, ext) {
  const cap = (s) => truncate(s, CONFIG.maxAttachmentChars);
  try {
    if (ext === '.pdf') {
      const r = await runPython(path.join(TOOLS_DIR, 'extract_pdf.py'), [savedPath, String(CONFIG.pdfMaxPages)]);
      if (!r.ok) return r;
      const summary = `PDF · 共 ${r.pages} 页${r.truncated ? `（已提取前 ${r.extracted_pages} 页）` : ''}`;
      if (!r.has_text) return { ok: true, kind: 'pdf', summary, text: '', pages: r.pages, hasText: false, warning: r.warning };
      return { ok: true, kind: 'pdf', summary, text: cap(r.text), pages: r.pages, hasText: true, truncated: r.truncated };
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const r = await runPython(path.join(TOOLS_DIR, 'extract_xlsx.py'), [savedPath, String(CONFIG.xlsxMaxRows)]);
      if (!r.ok) return r;
      const parts = [];
      for (const s of r.sheets) {
        parts.push(`### Sheet「${s.name}」（${s.rows} 行 × ${s.cols} 列${s.truncated ? `，仅提取前 ${CONFIG.xlsxMaxRows} 行` : ''}）\n\n${s.table}`);
      }
      return {
        ok: true,
        kind: 'xlsx',
        summary: `Excel · ${r.sheets.length} 个 Sheet${r.sheets.map((s) => `「${s.name}」`).join('')}`,
        text: cap(parts.join('\n\n')),
        sheetCount: r.sheets.length,
        sheetNames: r.sheets.map((s) => s.name),
        note: '公式显示为计算值；合并单元格仅左上角有值',
      };
    }
    if (FASTA_EXT.includes(ext)) {
      const raw = fs.readFileSync(savedPath, 'utf8');
      const { count, stats, seqs } = parseFasta(raw);
      if (!count) return { ok: false, error: '未识别到 FASTA 序列（缺少以 > 开头的注释行），请检查文件格式' };
      const statLines = stats.map((s) => `| ${s.id} | ${s.length} | ${s.gc} |`).join('\n');
      const seqLines = seqs
        .slice(0, 10)
        .map((s) => `> ${s.desc}\n${s.seq.length > 2000 ? s.seq.slice(0, 2000) + '…(截断)' : s.seq}`)
        .join('\n\n');
      return {
        ok: true,
        kind: 'fasta',
        summary: `FASTA · ${count} 条序列`,
        count,
        text: cap(`序列统计（ID | 长度 | GC 含量）：\n| ID | 长度 | GC |\n| --- | --- | --- |\n${statLines}\n\n序列内容（最多展示前 10 条）：\n${seqLines}${count > 10 ? `\n…(其余 ${count - 10} 条略)` : ''}`),
      };
    }
    // 其余按纯文本处理（txt/md/csv/json）
    const raw = fs.readFileSync(savedPath, 'utf8');
    const isJson = ext === '.json';
    if (isJson) {
      try { JSON.parse(raw); } catch { return { ok: false, error: 'JSON 文件格式不合法，无法解析' }; }
    }
    return {
      ok: true,
      kind: 'text',
      summary: `${ext.replace('.', '').toUpperCase()} · ${raw.length} 字符${raw.length > CONFIG.maxAttachmentChars ? '（已截断）' : ''}`,
      text: cap(raw),
    };
  } catch (e) {
    return { ok: false, error: `文件读取失败：${e.message}` };
  }
}

/* ---------------------------- 联网搜索（web_search） ---------------------------- */

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (m, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function searchDuckDuckGo(query) {
  const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': SEARCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  if (res.status === 403 || res.status === 429) throw new Error('被限流（HTTP ' + res.status + '）');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 6) {
    let url = decodeEntities(m[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    const title = stripTags(m[2]);
    if (title && /^https?:\/\//.test(url)) results.push({ title, url, snippet: '' });
  }
  const sre = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  let sm;
  while ((sm = sre.exec(html)) && i < results.length) {
    results[i].snippet = stripTags(sm[1]).slice(0, 200);
    i++;
  }
  if (!results.length) throw new Error('未解析到结果（页面结构变化或被反爬）');
  return results;
}

async function searchBing(query) {
  const res = await fetchWithTimeout(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans`, {
    headers: { 'User-Agent': SEARCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  if (res.status === 403 || res.status === 429) throw new Error('被限流（HTTP ' + res.status + '）');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const results = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 6) {
    const url = decodeEntities(m[1]);
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]).slice(0, 200);
    if (title && /^https?:\/\//.test(url)) results.push({ title, url, snippet });
  }
  if (!results.length) throw new Error('未解析到结果（页面结构变化或被反爬）');
  return results;
}

/** web_search 工具实现：DDG → Bing 双引擎降级；全失败时抛出带原因的错误 */
async function webSearch(query) {
  const engines = [['DuckDuckGo', searchDuckDuckGo], ['Bing', searchBing]];
  const errors = [];
  for (const [name, fn] of engines) {
    try {
      const rs = await fn(query);
      return `搜索「${query}」（引擎：${name}，时间：${new Date().toISOString()}）的结果：\n` +
        rs.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet || '（无摘要）'}`).join('\n');
    } catch (e) {
      errors.push(`${name}：${/abort/i.test(e.name || '') ? '超时（>10s）' : e.message}`);
    }
  }
  throw new Error(`联网搜索失败（${errors.join('；')}）。可能是网络不可达或被搜索引擎限流，请稍后重试或改用本地资料。`);
}

/* ---------------------------- BioNeMo（蛋白质结构预测） ---------------------------- */

const AA_SEQ_RE = /^[ARNDCQEGHILKMFPSTWYVXBOU]+$/;

/** 从 NIM 响应（结构未知）中递归找 PDB 文本（含 ATOM 与 END 记录的长字符串） */
function findPdbInResponse(o) {
  if (typeof o === 'string') return o.includes('ATOM') && o.includes('END') ? o : null;
  if (Array.isArray(o)) {
    for (const v of o) { const r = findPdbInResponse(v); if (r) return r; }
    return null;
  }
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) { const r = findPdbInResponse(v); if (r) return r; }
  }
  return null;
}

/** protein_structure 工具实现：调 BioNeMo ESMFold NIM，PDB 存工作区，返回摘要 */
async function predictProteinStructure(rawSequence) {
  if (!CONFIG.nvidiaApiKey) {
    throw new Error('未配置 NVIDIA_API_KEY：请到 https://build.nvidia.com 免费注册获取 API Key（nvapi- 开头），填入项目根目录 .env 的 NVIDIA_API_KEY= 后重启服务即可启用蛋白结构预测。');
  }
  // 清洗：去 FASTA 注释行与全部空白，转大写
  const seq = String(rawSequence || '')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('>'))
    .join('')
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!seq) throw new Error('氨基酸序列为空。请提供单字母氨基酸序列（如 MVHLTPEEKSAVTALWGK...）');
  if (seq.length > 1024) throw new Error(`序列长度 ${seq.length} 超过 ESMFold 上限 1024 个氨基酸，请截断或分段预测`);
  if (!AA_SEQ_RE.test(seq)) throw new Error('序列包含非法字符（仅允许 20 种标准氨基酸单字母及 X/B/O/U）。请确认输入的是蛋白质序列而非核酸或含数字的文本');

  let res;
  try {
    res = await fetchWithTimeout(CONFIG.nimBaseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.nvidiaApiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sequence: seq }),
    }, CONFIG.nimTimeoutMs);
  } catch (e) {
    const reason = /abort/i.test(e.name || '') ? `请求超时（>${CONFIG.nimTimeoutMs / 1000}s），结构预测较慢可稍后重试或在 .env 调大 NIM_TIMEOUT_MS` : e.message;
    throw new Error(`BioNeMo NIM 请求失败：${reason}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`NVIDIA_API_KEY 无效或未授权（HTTP ${res.status}），请检查 .env 中的 key`);
  if (res.status === 429) throw new Error('BioNeMo NIM 限流（HTTP 429），请稍后重试');
  if (!res.ok) throw new Error(`BioNeMo NIM 服务错误（HTTP ${res.status}）：${(await res.text().catch(() => '')).slice(0, 200)}`);

  const data = await res.json().catch(() => null);
  const pdb = data ? findPdbInResponse(data) : null;
  if (!pdb) {
    const rawFile = `pdb/esmfold_raw_${Date.now()}.json`;
    const rawPath = path.join(WORKSPACE_DIR, rawFile);
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    fs.writeFileSync(rawPath, JSON.stringify(data ?? { note: '空响应' }, null, 2), 'utf8');
    throw new Error(`未能从 NIM 响应中解析出 PDB 结构（原始响应已存 workspace/${rawFile} 供排查）`);
  }
  const file = `pdb/esmfold_${Date.now()}.pdb`;
  const fp = path.join(WORKSPACE_DIR, file);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, pdb, 'utf8');
  const atoms = (pdb.match(/^ATOM/gm) || []).length;
  return `结构预测成功。\n- 输入序列：${seq.length} 个氨基酸\n- ATOM 记录：${atoms} 条\n- PDB 文件已保存：workspace/${file}\n（可用 read_file 查看完整 PDB 内容）`;
}

/* ---------------------------- Biomni（生物医学子 agent） ---------------------------- */

/**
 * biomni_task 工具实现：spawn 独立 venv 子进程运行 Biomni A1。
 * 沙箱：子进程 cwd 锁定 workspace/biomni；主进程绝不 eval；
 *       11GB 数据湖跳过；超时由父进程 kill。
 */
function runBiomniTask(task) {
  return new Promise((resolve) => {
    if (!CONFIG.biomniPython) {
      resolve('未配置 BIOMNI_PYTHON：Biomni 需要独立 venv（见 README「Biomni 集成」），在 .env 中配置其 python.exe 路径后重启服务。');
      return;
    }
    const sandboxDir = path.join(WORKSPACE_DIR, 'biomni');
    fs.mkdirSync(sandboxDir, { recursive: true });
    const payload = JSON.stringify({
      task,
      model: CONFIG.biomniModel,
      baseUrl: CONFIG.baseUrl,
      apiKey: CONFIG.apiKey,
    });

    const child = execFile(
      CONFIG.biomniPython,
      [path.join(TOOLS_DIR, 'biomni_runner.py')],
      {
        cwd: sandboxDir,
        timeout: CONFIG.biomniTimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errMark = out.lastIndexOf('===BIOMNI_ERROR===');
        if (errMark >= 0) {
          resolve(truncate(`Biomni 运行出错：${out.slice(errMark + 17).trim()}\n--- stderr 尾部 ---\n${String(stderr || '').slice(-400)}`, CONFIG.maxToolOutput));
          return;
        }
        const mark = out.lastIndexOf('===BIOMNI_RESULT===');
        if (mark >= 0) {
          const result = out.slice(mark + 19).trim();
          const logTail = out.slice(0, mark).trim().slice(-1200);
          resolve(truncate(`Biomni 任务结束。\n--- 最终结果 ---\n${result}\n\n--- 过程日志（尾部） ---\n${logTail}`, CONFIG.maxToolOutput));
          return;
        }
        // 无标记：超时被 kill 或中途异常
        const hint = err && err.killed ? `（超时 >${CONFIG.biomniTimeoutMs / 1000}s 被终止）` : err ? `（${err.message.slice(0, 100)}）` : '';
        resolve(truncate(`Biomni 未产出最终结果${hint}。链路已运行，过程日志尾部：\n${out.slice(-1000) || '(无输出)'}\n--- stderr 尾部 ---\n${String(stderr || '').slice(-400)}`, CONFIG.maxToolOutput));
      }
    );
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/* ---------------------------- EveryInfra（数据平台 API） ---------------------------- */

const EI_SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 内置 HTTP 代理隧道（零依赖）：CONNECT 建立隧道后，https 目标再走 TLS，
 * 手写 HTTP/1.1 请求/响应解析（含 chunked 与 gzip/deflate/br 解压）。
 * 仅在配置 EVERYINFRA_PROXY 时启用；不依赖 undici 等第三方包。
 */
function eiNormalizeProxy(p) {
  const s = String(p || '').trim();
  if (!s) return null;
  return new URL(/^[a-z]+:\/\//i.test(s) ? s : `http://${s}`);
}

/** 解析代理隧道里的原始 HTTP 响应（状态行/头/chunked/压缩） */
function eiParseHttpResponse(buf) {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw new Error('代理隧道响应格式异常（未找到头部结束符）');
  const head = buf.slice(0, headerEnd).toString('latin1');
  const lines = head.split('\r\n');
  const m = lines[0].match(/^HTTP\/1\.[01] (\d{3})(?: (.*))?$/);
  if (!m) throw new Error(`代理隧道响应格式异常：${lines[0].slice(0, 60)}`);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }
  let body = buf.slice(headerEnd + 4);
  if ((headers['transfer-encoding'] || '').includes('chunked')) {
    const out = [];
    let pos = 0;
    while (pos + 5 <= body.length) {
      const lineEnd = body.indexOf('\r\n', pos);
      if (lineEnd < 0) break;
      const size = parseInt(body.slice(pos, lineEnd).toString('latin1').split(';')[0], 16);
      if (!size) break; // 0 块 = 结束
      out.push(body.slice(lineEnd + 2, lineEnd + 2 + size));
      pos = lineEnd + 2 + size + 2;
    }
    body = Buffer.concat(out);
  } else if (headers['content-length']) {
    body = body.slice(0, +headers['content-length']);
  }
  const enc = headers['content-encoding'];
  if (enc === 'gzip' || enc === 'x-gzip') body = zlib.gunzipSync(body);
  else if (enc === 'deflate') body = zlib.inflateSync(body);
  else if (enc === 'br') body = zlib.brotliDecompressSync(body);
  return { status: +m[1], text: body.toString('utf8') };
}

/** 走代理发一次 HTTP 请求（CONNECT 隧道；https 目标 TLS，http 目标明文） */
function eiProxyFetch(urlStr, { method = 'GET', headers = {}, body } = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const proxy = eiNormalizeProxy(CONFIG.everyinfraProxy);
    const fail = (e) => { try { sockRef && sockRef.destroy(); } catch { /* 已关闭 */ } reject(e); };
    let sockRef = null;
    const connectReq = http.request({
      host: proxy.hostname,
      port: +proxy.port || 80,
      method: 'CONNECT',
      path: `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`,
      headers: { Host: proxy.hostname },
      timeout: timeoutMs,
    });
    connectReq.on('connect', (res, socket) => {
      sockRef = socket;
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error(`代理 CONNECT 被拒绝（HTTP ${res.statusCode}），请检查 EVERYINFRA_PROXY 配置`));
      }
      const onTunnel = (sock) => {
        sockRef = sock;
        sock.setTimeout(timeoutMs, () => { sock.destroy(); fail(new Error(`代理隧道读取超时（>${timeoutMs / 1000}s）`)); });
        const h = {
          ...headers,
          Host: u.hostname,
          Connection: 'close', // 单次请求，读完即关，简化响应边界
          'Accept-Encoding': 'gzip', // 让大响应可压缩，解压由 eiParseHttpResponse 处理
        };
        if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
        let raw = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(h)) raw += `${k}: ${v}\r\n`;
        sock.write(raw + '\r\n' + (body ?? ''));
        const chunks = [];
        sock.on('data', (c) => chunks.push(c));
        sock.on('error', fail);
        sock.on('close', () => {
          if (!chunks.length) return fail(new Error('代理隧道响应为空'));
          try { resolve(eiParseHttpResponse(Buffer.concat(chunks))); } catch (e) { fail(e); }
        });
      };
      if (u.protocol === 'https:') {
        const tlsSock = tls.connect({ socket, servername: u.hostname, timeout: timeoutMs }, () => onTunnel(tlsSock));
        tlsSock.on('error', fail);
      } else {
        onTunnel(socket);
      }
    });
    connectReq.on('error', fail);
    connectReq.on('timeout', () => { connectReq.destroy(); fail(new Error(`连接代理超时（>${timeoutMs / 1000}s），请确认 EVERYINFRA_PROXY 端口在监听`)); });
    connectReq.end();
  });
}

/** EveryInfra 统一请求：拼 URL/鉴权头，配了 EVERYINFRA_PROXY 走内置隧道，否则直连；返回 {status, ok, data} */
async function eiFetch(pathname, { method = 'GET', body } = {}) {
  const url = `${CONFIG.everyinfraBaseUrl}${pathname}`;
  const headers = {
    Accept: 'application/json',
    ...(CONFIG.everyinfraApiKey ? { Authorization: `Bearer ${CONFIG.everyinfraApiKey}` } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  let status;
  let text;
  if (CONFIG.everyinfraProxy) {
    const r = await eiProxyFetch(url, { method, headers, body: payload }, CONFIG.everyinfraTimeoutMs);
    status = r.status;
    text = r.text;
  } else {
    const res = await fetchWithTimeout(url, { method, headers, ...(payload !== undefined ? { body: payload } : {}) }, CONFIG.everyinfraTimeoutMs);
    status = res.status;
    text = await res.text();
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  return { status, ok: status >= 200 && status < 300, data };
}

/** 网络层异常翻译成模型可读的中文提示（代理/超时/不可达） */
function eiWrapNetworkError(e) {
  if (/abort/i.test(e.name || '') || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(e.message || '')) {
    return new Error(`EveryInfra 网络请求失败（${e.cause?.code || e.cause?.message || e.message}）。api.everyinfra.com 在部分网络环境下直连不通，可在 .env 配置 EVERYINFRA_PROXY=http://127.0.0.1:7897（本机代理端口，如 Clash Verge 7897 / Clash 7890 / v2rayN 10809）后重启服务；也可稍后重试。`);
  }
  return e;
}

async function eiRequest(pathname, init) {
  try {
    return await eiFetch(pathname, init);
  } catch (e) {
    throw eiWrapNetworkError(e);
  }
}

/** 异步任务轮询：202 + job_id → 每 2s 查一次，直到完成/失败/超过等待上限 */
async function eiWaitJob(jobId) {
  const deadline = Date.now() + CONFIG.everyinfraJobMaxWaitMs;
  let polled = 0;
  while (Date.now() < deadline) {
    await EI_SLEEP(2000);
    const { data } = await eiRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
    polled++;
    const st = String(data?.status || '').toLowerCase();
    if (st === 'completed' || st === 'succeeded' || st === 'done') return data?.result !== undefined ? data.result : data;
    if (st === 'failed' || st === 'error') throw new Error(`EveryInfra 异步任务失败：${truncate(JSON.stringify(data?.error || data), 300)}`);
  }
  throw new Error(`EveryInfra 异步任务 ${jobId} 等待超时（>${CONFIG.everyinfraJobMaxWaitMs / 1000}s，已轮询 ${polled} 次）。任务可能仍在后台执行：稍后用 kind=job, job_id="${jobId}" 再查一次即可拿到结果。`);
}

/** 业务响应 → 落地：完整 JSON 存 workspace/everyinfra/，返回摘要 + 预览 + 翻页提示 */
function eiSaveResult(tag, data) {
  const json = JSON.stringify(data, null, 2);
  const file = `everyinfra/${tag}_${Date.now()}.json`;
  const fp = path.join(WORKSPACE_DIR, file);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, json, 'utf8');
  const pageToken = data && typeof data.next_page_token === 'string' && data.next_page_token
    ? `\n- 分页：还有下一页，把 params.page_token 设为 "${data.next_page_token}" 再次调用可获取后续数据`
    : '';
  return `- 完整数据已保存：workspace/${file}（${json.length} 字符）\n- 结果预览：\n${truncate(json, 1500)}${pageToken}`;
}

/** HTTP 状态码 → 友好错误（鉴权/额度/限流/参数），成功则进入落地/异步流程 */
async function eiHandle(tag, { status, data }) {
  if (status === 202 && (data?.job_id || data?.jobId)) {
    const jobId = data.job_id || data.jobId;
    const result = await eiWaitJob(jobId);
    return `请求已异步执行（job_id=${jobId}），任务已完成。\n` + eiSaveResult(`${tag}_job`, result);
  }
  if (status === 401 || status === 403) {
    throw new Error(`EVERYINFRA_API_KEY 无效或未授权（HTTP ${status}）${status === 403 ? '，也可能是账户额度不足：请到 https://console.everyinfra.com 的 Billing 页兑换额度码或充值' : '，请检查 .env 中的 key（sk- 开头）'}`);
  }
  if (status === 402) throw new Error('EveryInfra 账户额度不足（HTTP 402）：请到 https://console.everyinfra.com 的 Billing 页兑换额度码或充值。');
  if (status === 429) throw new Error('EveryInfra 限流（HTTP 429），请间隔几秒后重试。');
  if (status === 404) throw new Error(`接口或参数不存在（HTTP 404）：${truncate(JSON.stringify(data), 200)}。可用 kind=catalog 核对平台/动作/工具名。`);
  if (status >= 400) throw new Error(`EveryInfra 请求失败（HTTP ${status}）：${truncate(JSON.stringify(data), 300)}`);
  return eiSaveResult(tag, data);
}

/** everyinfra_data 工具实现：catalog（免 key）/ social / search / job 四种请求 */
async function everyinfraData(args) {
  const kind = String(args.kind || '').trim().toLowerCase();
  const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
  const needKey = () => {
    if (!CONFIG.everyinfraApiKey) {
      throw new Error('未配置 EVERYINFRA_API_KEY：请到 https://console.everyinfra.com 注册，在 Billing 页兑换额度码并创建 API key（sk- 开头），填入项目根目录 .env 的 EVERYINFRA_API_KEY= 后重启服务。查平台目录可用 kind=catalog（免 key）。');
    }
  };

  if (kind === 'catalog') {
    const platform = String(args.platform || '').trim().toLowerCase();
    if (platform) {
      const r = await eiRequest(`/api/v1/social/catalog?platform=${encodeURIComponent(platform)}`);
      if (r.status === 404) throw new Error(`平台「${platform}」不存在。先用 kind=catalog（不带 platform）获取支持的完整平台列表。`);
      if (!r.ok) throw new Error(`catalog 查询失败（HTTP ${r.status}）：${truncate(JSON.stringify(r.data), 200)}`);
      // 真实结构：{platforms:[全量名], capabilities:[{action,action_label,required_params,optional_params,mode,cost_credits,price_cny}]}
      const caps = (r.data?.capabilities || []).filter((c) => String(c.platform || '').toLowerCase() === platform);
      if (!caps.length) return `平台「${platform}」暂无能力目录（catalog 响应：${truncate(JSON.stringify(r.data), 800)}）`;
      const lines = caps.map((c) => {
        const req = (c.required_params || []).join(',');
        const opt = (c.optional_params || []).filter((p) => p !== 'page_token').join(',');
        return `- ${c.action}（${c.action_label || c.action}${c.mode === 'async' ? '，仅异步' : ''}）：params 必填 {${req}}${opt ? `，可选 {${opt}}` : ''}；¥${c.price_cny ?? '?'} /次`;
      });
      return `平台「${platform}」支持的动作（发起请求用 kind=social, platform=${platform}, action=<动作>，params 按下方必填/可选填写）：\n${lines.join('\n')}`;
    }
    const [c, t] = await Promise.all([
      eiRequest('/api/v1/social/catalog'),
      eiRequest('/api/v1/search/tools'),
    ]);
    if (!c.ok) throw new Error(`平台目录查询失败（HTTP ${c.status}）：${truncate(JSON.stringify(c.data), 200)}`);
    const platforms = Array.isArray(c.data?.platforms) ? c.data.platforms : [];
    const tools = Array.isArray(t.data?.tools) ? t.data.tools : [];
    const toolLines = tools.map((x) => {
      const name = x.tool || x.name || x;
      const req = (x.required_params || []).join(',');
      return `${name}${req ? `(${req})` : ''}`;
    });
    return `EveryInfra 目录（免 key 查询）：\n- 数据平台（${platforms.length} 个）：${platforms.join(', ')}\n- 搜索工具（${tools.length} 个，括号内为必填参数）：${toolLines.join(', ')}\n用 kind=catalog 加 platform=<名称> 查该平台的动作/参数/价格；kind=social / kind=search 发起数据请求（需 key）。`;
  }

  if (kind === 'social') {
    needKey();
    const platform = String(args.platform || '').trim().toLowerCase();
    const action = String(args.action || '').trim().toLowerCase();
    if (!platform || !action) throw new Error('kind=social 需要 platform 与 action 参数（如 xiaohongshu + search）。不确定取值时先用 kind=catalog&platform=<平台名> 查询。');
    const body = { platform, action, params };
    if (String(args.mode || '').toLowerCase() === 'async') body.mode = 'async';
    const r = await eiRequest('/api/v1/social', { method: 'POST', body });
    return `EveryInfra social 请求成功（${platform}.${action}${body.mode ? '，异步' : ''}）。\n` + (await eiHandle(`${platform}_${action}`, r));
  }

  if (kind === 'search') {
    needKey();
    const tool = String(args.tool || '').trim().toLowerCase();
    if (!tool) throw new Error('kind=search 需要 tool 参数（如 web/news/scholar/semantic/read）。完整列表用 kind=catalog 查询。');
    const body = { tool, params };
    if (String(args.mode || '').toLowerCase() === 'async') body.mode = 'async';
    const r = await eiRequest('/api/v1/search', { method: 'POST', body });
    return `EveryInfra search 请求成功（${tool}）。\n` + (await eiHandle(`search_${tool}`, r));
  }

  if (kind === 'job') {
    needKey();
    const jobId = String(args.job_id || args.jobId || '').trim();
    if (!jobId) throw new Error('kind=job 需要 job_id 参数。');
    const r = await eiRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
    if (r.status >= 400) throw new Error(`任务查询失败（HTTP ${r.status}）：${truncate(JSON.stringify(r.data), 300)}`);
    const st = String(r.data?.status || '').toLowerCase();
    if (st && st !== 'completed' && st !== 'succeeded' && st !== 'done') {
      return `任务 ${jobId} 状态：${st || '进行中'}（尚未完成）。稍后再查，或直接把该 job_id 告诉用户。\n${truncate(JSON.stringify(r.data), 800)}`;
    }
    return `任务 ${jobId} 已完成。\n` + eiSaveResult(`job_${String(jobId).slice(0, 16)}`, r.data?.result !== undefined ? r.data.result : r.data);
  }

  throw new Error(`未知 kind「${kind}」。支持：catalog（免 key 目录）/ social（平台数据）/ search（搜索工具）/ job（查异步任务）。`);
}

/* ---------------------------- GLM 流式调用 ---------------------------- */

const SYSTEM_PROMPT = `你是一个运行在用户电脑上的智能 Agent（类似 DeepSeek Harness 的代理运行时），你的工作目录是 "${WORKSPACE_DIR}"。
你可以调用工具来完成任务：
- run_command：在工作区执行 shell 命令（查看文件、跑脚本、git 等）
- read_file / write_file / list_dir：管理工作区文件
- web_search：联网搜索最新信息。涉及时事、版本号、价格、最新资料时优先使用它而不是凭记忆回答，且回答中必须用 Markdown 链接标注来源。

使用原则：
1. 简单闲聊或知识问答直接回答，不必调用工具。
2. 涉及文件、命令、代码验证、数据处理等实际操作时，先思考计划，再调用工具，并根据工具结果继续或总结。
3. 用户消息可能附带 [附件 ...] 块（PDF/Excel/FASTA/文本的提取内容）：优先依据附件内容回答；若提取内容被截断或需要更多细节，可用 read_file 读取附件的完整原始文件（附件块中给出了工作区路径）。图片附件会直接出现在消息里，用视觉能力理解它。
4. 工具输出可能被截断，注意甄别。
5. 默认使用中文回答。回答使用 Markdown 格式，代码用代码块包裹。

【需求不明确时必须澄清】
当用户的需求模糊、存在多种合理理解、或缺少关键参数时，不要猜测着直接动手。先输出一个选项卡片向用户提问，格式为（严格遵守，便于前端解析）：

\`\`\`options
{"question": "你的问题", "style": "single 或 multi", "options": ["选项A的描述", "选项B的描述", "选项C的描述"]}
\`\`\`

规则：
- 选项必须互斥、覆盖主要可能性，【数量必须是 2-4 个】（只写 1 个选项是错误用法）；style=multi 表示可多选。
- 示例：{"question":"你想处理哪种数据？","style":"single","options":["Excel/CSV 表格数据（清洗、统计）","文本数据（提取、总结）","代码/脚本数据（重构、调试）"]}
- 输出选项卡片后立即停止，等待用户选择，不要自问自答。
- 【重要】需求模糊时，你的第一反应就是提问：不要先调用工具探索，也不要在输出选项卡片的同时调用工具。等用户选择后再执行。
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
    max_tokens: CONFIG.maxTokensByModel[model] ?? CONFIG.maxTokens,
  };
  if (tools && tools.length) body.tools = tools;

  // 空闲看门狗：每收到一个 chunk 刷新时间戳，超过 streamIdleTimeoutMs 无数据则 abort，
  // for await 会抛错并在下方翻译成用户可读提示（runAgent 抛出后由路由发 error/done 事件收尾）
  const controller = new AbortController();
  let lastActiveAt = Date.now();
  let idleFired = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastActiveAt >= CONFIG.streamIdleTimeoutMs) {
      idleFired = true;
      controller.abort();
    }
  }, Math.max(250, Math.min(1000, Math.floor(CONFIG.streamIdleTimeoutMs / 10))));

  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let finishReason = null;
  const toolCalls = {}; // index -> {id, name, argsStr}

  try {
    const res = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try { msg = JSON.parse(text).error?.message || text; } catch {}
      const err = new Error(`GLM API ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }

    for await (const chunk of res.body) {
      lastActiveAt = Date.now();
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
  } catch (e) {
    if (idleFired) {
      throw new Error(`GLM API 流式响应超过 ${Math.round(CONFIG.streamIdleTimeoutMs / 1000)} 秒未收到任何数据，已自动断开（疑似网络或代理中断）。请重试；若频繁出现请检查网络或代理设置。`);
    }
    throw e;
  } finally {
    clearInterval(watchdog);
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

/** 把存储中的会话消息转成 API 消息（去掉 reasoning，保留 tool_calls/tool 轮次；历史图片限流；超长截断）。
 *  stripToolTurns=true（规划模式）时去除全部工具轮次：历史里的调用示范会诱导模型在本应只出计划的回合模仿调工具 */
function toApiMessages(convMessages, visionModel, stripToolTurns = false) {
  const out = [{ role: 'system', content: SYSTEM_PROMPT }];

  // 超长对话截断：保留首条 user（任务背景）+ 截断说明 + 最近 N 条
  // 起点若落在 tool 消息上则后移，避免 assistant(tool_calls) 与 tool 结果被拆散导致 API 报错
  let msgs = convMessages;
  if (convMessages.length > CONFIG.contextWindowMessages) {
    let start = convMessages.length - CONFIG.contextWindowMessages;
    while (start < convMessages.length && convMessages[start].role === 'tool') start++;
    const firstUserIdx = convMessages.findIndex((m) => m.role === 'user');
    const head = firstUserIdx >= 0 && firstUserIdx < start ? [convMessages[firstUserIdx]] : [];
    msgs = [
      ...head,
      { role: 'assistant', content: `（系统注：为控制上下文长度，中间约 ${start - head.length} 条历史消息已被截断，对话仍可继续。）` },
      ...convMessages.slice(start),
    ];
  }

  // 仅保留最近 3 条带图消息的图片，更早的用占位文本，避免上下文膨胀
  const imgIdx = [];
  msgs.forEach((m, i) => { if (m.role === 'user' && m.images?.length) imgIdx.push(i); });
  const keepImg = new Set(imgIdx.slice(-3));
  msgs.forEach((m, i) => {
    if (m.role === 'user') {
      let text = m.content;
      // 附件提取文本注入（原始文件已存于工作区，模型可用 read_file 深入查看）
      for (const a of m.attachments || []) {
        text += `\n\n[附件 ${a.name}${a.summary ? '：' + a.summary : ''}${a.path ? `（工作区路径 ${a.path}）` : ''}]`;
        if (a.text) text += `\n<附件内容>\n${a.text}\n</附件内容>`;
        else if (a.summary) text += `\n（该附件无可注入的文本内容）`;
      }
      if (m.images?.length && !keepImg.has(i)) text = (text || '') + '\n[注：用户曾发送过图片，因对话过长已省略]';
      if (m.images?.length && keepImg.has(i) && visionModel) {
        out.push({
          role: 'user',
          content: [
            ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
            { type: 'text', text: text || '（请看图）' },
          ],
        });
      } else {
        out.push({ role: 'user', content: text });
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (!stripToolTurns && m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool' && m.tool_call_id) {
      if (stripToolTurns) return; // forEach 内 return 即 continue
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    }
  });
  return out;
}

/** 校验图片消息：格式 / 大小 / 模型能力，返回错误对象或 null */
function validateImages(images, model) {
  if (!Array.isArray(images) || !images.length) return null;
  if (images.length > CONFIG.maxImagesPerMessage) {
    return { code: 400, error: `图片数量超过上限（${CONFIG.maxImagesPerMessage} 张），请分批发送。` };
  }
  if (!CONFIG.visionModels.includes(model)) {
    return { code: 400, error: `当前模型 ${model} 不支持图片输入。请在右上角模型下拉中切换到视觉模型（如 glm-4v-flash，免费）后重试。` };
  }
  for (const img of images) {
    const s = String(img || '');
    const m = s.match(/^data:image\/(png|jpe?g|webp);base64,/);
    if (!m) return { code: 400, error: '图片格式仅支持 PNG / JPG / WEBP，请转换格式后重试。' };
    const bytes = Math.floor(((s.length - s.indexOf(',') - 1) * 3) / 4);
    if (bytes > CONFIG.imageMaxBytes) {
      return { code: 400, error: `图片过大（约 ${(bytes / 1048576).toFixed(1)}MB），单张上限 ${Math.round(CONFIG.imageMaxBytes / 1048576)}MB，请压缩后重试。` };
    }
  }
  return null;
}

/**
 * 运行一次完整 Agent 对话循环。
 * onEvent 会收到（全部最终转发给前端 SSE）：
 *   reasoning / content / tool_call / tool_result / step / done / error
 */
async function runAgent(conv, userText, model, onEvent, isAborted, opts = {}) {
  const planMode = opts.mode === 'plan';
  const userMsg = {
    id: crypto.randomUUID(),
    role: 'user',
    content: userText,
    images: opts.images || [],
    attachments: opts.attachments || [],
    ts: Date.now(),
  };
  conv.messages.push(userMsg);
  if (conv.messages.filter((m) => m.role === 'user').length === 1) {
    conv.title = userText.replace(/\s+/g, ' ').slice(0, 24) || '新对话';
  }

  const apiMessages = toApiMessages(conv.messages, CONFIG.visionModels.includes(model), planMode);
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

    // 硬约束①：模型在输出澄清选项（```options）的回合不应执行动作——
    // 即使它同时发起了 tool_calls 也忽略，等用户选择后再执行
    // 硬约束②：规划模式只出计划、绝不执行——模型违规发出的 tool_calls 一律忽略
    const wantsClarify = /```options/.test(r.content || '');

    if (!planMode && r.toolCalls.length && r.finishReason === 'tool_calls' && !wantsClarify) {
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
      visionModels: CONFIG.visionModels,
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

  if (pathname === '/api/upload' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const b64 = String(body.data || '').split(',').pop();
    if (!name || !b64) return sendJson(res, 400, { error: '上传内容为空' });
    const ext = path.extname(name).toLowerCase();
    if (!UPLOAD_ALLOWED_EXT.includes(ext)) {
      return sendJson(res, 400, { error: `不支持的文件类型「${ext || name}」。支持：${UPLOAD_ALLOWED_EXT.join(' / ')}` });
    }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return sendJson(res, 400, { error: '文件内容为空或已损坏' });
    if (buf.length > CONFIG.uploadMaxBytes) {
      return sendJson(res, 400, { error: `文件过大（${(buf.length / 1048576).toFixed(1)}MB），上限 ${Math.round(CONFIG.uploadMaxBytes / 1048576)}MB` });
    }
    const upDir = path.join(WORKSPACE_DIR, 'uploads');
    fs.mkdirSync(upDir, { recursive: true });
    const saved = `${Date.now()}_${name}`;
    const savedPath = path.join(upDir, saved);
    fs.writeFileSync(savedPath, buf);
    const extraction = await extractDocument(savedPath, name, ext);
    return sendJson(res, 200, {
      name,
      path: `uploads/${saved}`,
      size: buf.length,
      extraction,
    });
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    if (!CONFIG.apiKey) {
      return sendJson(res, 500, { error: '未配置 GLM_API_KEY，请在项目根目录 .env 中填写后重启服务' });
    }
    const body = await readBody(req);
    const userText = String(body.message || '').trim();
    if (!userText && !body.images?.length) return sendJson(res, 400, { error: '消息不能为空' });

    let conv = body.conversationId ? store.data[body.conversationId] : null;
    if (!conv) conv = newConversation();
    conv.updatedAt = Date.now();
    const model = CONFIG.models.includes(body.model) || body.model ? String(body.model || CONFIG.model) : CONFIG.model;
    const mode = body.mode === 'plan' ? 'plan' : 'chat';

    // 图片校验（格式 / 大小 / 数量 / 模型能力），错误信息面向用户可直接展示
    const imgErr = validateImages(body.images, model);
    if (imgErr) return sendJson(res, imgErr.code, { error: imgErr.error });

    // 附件校验与清洗（由 /api/upload 产出）
    const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 4).map((a) => ({
      name: String(a?.name || '附件').slice(0, 120),
      path: String(a?.path || '').slice(0, 300),
      summary: String(a?.summary || '').slice(0, 200),
      text: String(a?.text || '').slice(0, CONFIG.maxAttachmentChars),
    })) : [];

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
      await runAgent(conv, userText, model, send, () => clientGone || res.writableEnded, { mode, images: body.images, attachments });
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
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 前端迭代频繁，禁用缓存避免更新后需要强刷
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

if (require.main === module) {
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
}

// 供 tests/ 单测引用（node server.js 直接运行时不会导出副作用）
module.exports = { CONFIG, TOOLS, executeTool, everyinfraData, runAgent };
