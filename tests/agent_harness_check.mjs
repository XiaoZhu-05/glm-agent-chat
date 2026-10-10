/**
 * Agent 循环安全护栏验证（自包含，无需真实 GLM key / 外网 / 真实会话存储）
 * 用法：node tests/agent_harness_check.mjs
 * 原理：
 *   - 在 127.0.0.1 起 mock GLM SSE 服务（场景可切换：正常两轮带工具调用 / 发一帧后挂死）
 *   - 以隔离 env require server.js（DATA_DIR 指向临时目录，不碰真实 data/conversations.json），
 *     直接调用 runAgent 走完整 Agent 循环
 * 覆盖：
 *   H1 聊天模式回归：正常执行工具、两轮收尾、请求携带 tools 与历史工具轮次
 *   H2 规划模式守卫：模型违规发出的 tool_calls 被忽略，绝不执行（不发出 tool_call 事件）
 *   H3 历史过滤：规划模式发给 API 的消息不含任何工具轮次，聊天模式保留（回归）
 *   H4 流式挂死：上游长时间无数据时按空闲超时中断，抛出用户可读错误（而非永久等待）
 *   H6 自纠重试闭环：工具出错 → 错误原文回填给模型 → 换正确参数重试 → 正常收尾
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);
const SERVER_PATH = require.resolve('../server.js');

const results = [];
function record(id, name, expected, actual, pass) {
  results.push({ id, name, pass });
  console.log(`${pass ? '✅' : '❌'} [${id}] ${name}`);
  if (!pass) console.log(`   预期: ${expected}\n   实际: ${String(actual).slice(0, 300)}`);
}

/* ---------------- mock GLM SSE 服务 ---------------- */

let scenario = 'normal'; // normal | stall
let round = 0; // normal 场景的轮次：1 → 回放 tool_calls，≥2 → 正常收尾
const bodies = []; // 记录每次请求体，供断言 tools / messages 结构

const sockets = new Set();
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
    bodies.push(body);
    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });

    if (scenario === 'stall') {
      // 发一帧 reasoning 后既不结束也不继续：模拟上游/代理中途挂死
      sse({ choices: [{ delta: { reasoning_content: '思考中…' } }] });
      return;
    }

    round += 1;
    if (scenario === 'retry') {
      // 模拟"先错后改"的自纠模型：第 1 轮读不存在的文件，第 2 轮换正确路径重试，第 3 轮收尾
      if (round === 1) {
        sse({ choices: [{ delta: { content: '我读一下那个文件。' } }] });
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_r1', function: { name: 'read_file', arguments: '{"path":"no_such_file_xyz.txt"}' } }] } }] });
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (round === 2) {
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_r2', function: { name: 'read_file', arguments: '{"path":"about.md"}' } }] } }] });
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      sse({ choices: [{ delta: { content: '读到了，自我纠正成功，任务完成。' } }] });
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (round === 1) {
      // 第一轮：正文 + 一个工具调用（list_dir，安全只读）
      sse({ choices: [{ delta: { content: '我先看一下目录。' } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_h1', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }] });
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    // 第二轮（已看到工具结果）：正常收尾
    sse({ choices: [{ delta: { content: '目录已列出，任务完成。' } }] });
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
mock.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
console.log(`mock GLM SSE: ${MOCK}`);

/* ---------------- 隔离 env 加载 server.js ---------------- */

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harness-data-'));
const ENV_KEYS = ['GLM_API_KEY', 'GLM_BASE_URL', 'GLM_STREAM_IDLE_TIMEOUT_MS', 'DATA_DIR'];
function freshServer(env) {
  // 全量置空再覆盖：与真实 .env 及上一实例完全隔离（空字符串 falsy 且已在 env 中，loadEnv 不会覆盖）
  for (const k of ENV_KEYS) process.env[k] = '';
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  process.env.DATA_DIR = process.env.DATA_DIR || TMP_DATA;
  delete require.cache[SERVER_PATH];
  return require(SERVER_PATH); // require.main 守卫：不 listen
}

/** 预置一段带工具轮次的历史（诱导模型模仿调用） */
function seedConversation() {
  const id = 'conv-test-' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    title: '测试会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      { id: 'm1', role: 'user', content: '上次帮我列一下工作区', ts: 1 },
      { id: 'm2', role: 'assistant', content: '我来查看。', reasoning: '', tool_calls: [{ id: 'call_seed', name: 'list_dir', args: { path: '.' } }], ts: 2 },
      { id: 'm3', role: 'tool', tool_call_id: 'call_seed', name: 'list_dir', content: 'a.txt\nb.txt', ok: true, ts: 3 },
      { id: 'm4', role: 'assistant', content: '工作区里有 a.txt 和 b.txt。', reasoning: '', tool_calls: [], ts: 4 },
    ],
  };
}

async function runAgentCollect(srv, conv, text, opts) {
  const events = [];
  await srv.runAgent(conv, text, 'glm-5.3', (e) => events.push(e), null, opts || {});
  return events;
}

(async () => {
  let failed = 0;
  try {
  /* -- H1/H3（聊天模式）：正常执行 + 历史工具轮次保留 -- */
  const chat = freshServer({ GLM_BASE_URL: MOCK, GLM_API_KEY: 'test-key' });
  scenario = 'normal'; round = 0; bodies.length = 0;
  const conv1 = seedConversation();
  const ev1 = await runAgentCollect(chat, conv1, '再列一次', {});

  const ev1ToolCall = ev1.find((e) => e.type === 'tool_call');
  const ev1ToolResult = ev1.find((e) => e.type === 'tool_result');
  const ev1Done = ev1.find((e) => e.type === 'done');
  record('H1', '聊天模式：执行工具并正常收尾', 'tool_call=list_dir、tool_result ok、done 含"任务完成"',
    JSON.stringify({ toolCall: ev1ToolCall?.name, ok: ev1ToolResult?.ok, done: ev1Done?.message?.content?.slice(0, 20) }),
    ev1ToolCall?.name === 'list_dir' && ev1ToolResult?.ok === true && /任务完成/.test(ev1Done?.message?.content || ''));

  const req1 = bodies[0] || {};
  const toolNames = Array.isArray(req1.tools) ? req1.tools.map((t) => t.function?.name) : null;
  const hasSeedToolTurn = (req1.messages || []).some((m) => m.role === 'tool');
  record('H3a', '聊天模式：请求携带 tools 且保留历史工具轮次', 'tools 含 list_dir；messages 含 role:tool',
    JSON.stringify({ toolNames, hasSeedToolTurn }),
    Array.isArray(toolNames) && toolNames.includes('list_dir') && hasSeedToolTurn === true);

  /* -- H2/H3（规划模式）：tool_calls 被忽略 + 历史工具轮次被过滤 -- */
  const plan = freshServer({ GLM_BASE_URL: MOCK, GLM_API_KEY: 'test-key' });
  scenario = 'normal'; round = 0; bodies.length = 0;
  const conv2 = seedConversation();
  const ev2 = await runAgentCollect(plan, conv2, '再列一次', { mode: 'plan' });

  const noExec = !ev2.some((e) => e.type === 'tool_call' || e.type === 'tool_result');
  const ev2Done = ev2.find((e) => e.type === 'done');
  record('H2', '规划模式：模型违规 tool_calls 被忽略，绝不执行', '无 tool_call/tool_result 事件；done 含模型正文',
    JSON.stringify({ noExec, done: ev2Done?.message?.content?.slice(0, 20), events: ev2.map((e) => e.type) }),
    noExec && /我先看一下目录/.test(ev2Done?.message?.content || ''));

  const req2 = bodies[0] || {};
  const planMsgs = req2.messages || [];
  const sys = planMsgs[0]?.content || '';
  const hasToolRole = planMsgs.some((m) => m.role === 'tool');
  const hasAssistantToolCalls = planMsgs.some((m) => m.role === 'assistant' && m.tool_calls?.length);
  record('H3b', '规划模式：请求不带 tools、系统提示注入规划约束、历史工具轮次全过滤',
    'tools 未定义；system 含"规划模式（当前生效）"；无 role:tool；assistant 无 tool_calls',
    JSON.stringify({ tools: req2.tools, planSuffix: sys.includes('规划模式（当前生效）'), hasToolRole, hasAssistantToolCalls }),
    req2.tools === undefined && sys.includes('规划模式（当前生效）') && !hasToolRole && !hasAssistantToolCalls);
  record('H3c', '规划模式：单轮即止（不进入工具循环的第二轮请求）', 'bodies.length=1', `bodies.length=${bodies.length}`, bodies.length === 1);

  /* -- H6：工具出错 → 错误回填给模型 → 自我纠正换正确参数重试 → 正常收尾 -- */
  const retrySrv = freshServer({ GLM_BASE_URL: MOCK, GLM_API_KEY: 'test-key' });
  scenario = 'retry'; round = 0; bodies.length = 0;
  const conv6 = seedConversation();
  const ev6 = await runAgentCollect(retrySrv, conv6, '看看 about.md', {});
  const failedResult = ev6.find((e) => e.type === 'tool_result' && e.ok === false);
  const okResults = ev6.filter((e) => e.type === 'tool_result' && e.ok === true);
  const ev6Done = ev6.find((e) => e.type === 'done');
  const req2msgs = (bodies[1] || {}).messages || [];
  const sawErrorInContext = req2msgs.some((m) => m.role === 'tool' && /工具执行出错/.test(m.content || ''));
  record('H6', '工具出错→错误原文回传→自纠重试→收尾', 'ok=false 结果存在；第 2 轮请求含错误原文；重试成功；done 含"任务完成"',
    JSON.stringify({ failed: Boolean(failedResult), okCount: okResults.length, sawErrorInContext, done: ev6Done?.message?.content?.slice(0, 12) }),
    Boolean(failedResult) && sawErrorInContext && okResults.length >= 1 && /任务完成/.test(ev6Done?.message?.content || ''));

  /* -- H4：上游流挂死 → 空闲超时中断 -- */
  const stalling = freshServer({ GLM_BASE_URL: MOCK, GLM_API_KEY: 'test-key', GLM_STREAM_IDLE_TIMEOUT_MS: '400' });
  scenario = 'stall'; bodies.length = 0;
  const conv4 = seedConversation();
  const t0 = Date.now();
  let err4 = null;
  try {
    await stalling.runAgent(conv4, '查一下', 'glm-5.3', () => {}, null, {});
  } catch (e) {
    err4 = e;
  }
  const elapsed = Date.now() - t0;
  record('H4', '流式挂死：超时中断并抛出用户可读错误', '错误含"未收到任何数据"，且 ~0.4-5s 内返回',
    JSON.stringify({ msg: err4?.message, elapsed }),
    Boolean(err4) && /未收到任何数据/.test(err4.message) && elapsed < 5000);

  /* -- 附加：DATA_DIR 隔离生效（会话写进临时目录，不碰真实 data/） -- */
  await new Promise((r) => setTimeout(r, 300)); // store.save 有 200ms 防抖
  record('H5', '会话存储写入临时 DATA_DIR', `存在 ${path.join(TMP_DATA, 'conversations.json')}`,
    fs.existsSync(path.join(TMP_DATA, 'conversations.json')) ? '已写入临时目录' : '未找到',
    fs.existsSync(path.join(TMP_DATA, 'conversations.json')));
  } finally {
    failed = results.filter((r) => !r.pass).length;
    console.log(`\n结果：${results.length - failed}/${results.length} 通过${failed ? `，${failed} 失败` : ''}`);

    sockets.forEach((s) => { try { s.destroy(); } catch { /* 已关闭 */ } });
    await new Promise((r) => mock.close(r));
    fs.rmSync(TMP_DATA, { recursive: true, force: true });
  }
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exitCode = 1;
});
