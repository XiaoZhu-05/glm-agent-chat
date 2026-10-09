/**
 * GLM Agent Chat 功能验证测试（E2E）
 * 用法：node tests/e2e.mjs [baseUrl]
 * 前置：服务已启动（node server.js），tests/fixtures/ 已生成（python tests/fixtures_gen.py）
 * 输出：控制台 Markdown 结果表 + tests/results.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://localhost:3210';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures');
const TEXT_MODEL = process.env.TEXT_MODEL || 'glm-4.5-flash';
const VISION_MODEL = 'glm-4v-flash';

const results = [];
function record(id, name, expected, actual, pass, evidence = '') {
  results.push({ id, name, expected, actual: String(actual).slice(0, 300), pass, evidence: String(evidence).slice(0, 500) });
  console.log(`${pass ? '✅' : '❌'} [${id}] ${name}`);
  if (!pass) console.log(`   预期: ${expected}\n   实际: ${String(actual).slice(0, 300)}`);
}

/** 调 /api/chat 并收集全部 SSE 事件 */
async function chat({ message, conversationId, model = TEXT_MODEL, mode, images, attachments }) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId, model, mode, images, attachments }),
  });
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('event-stream')) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    return { httpError: true, status: res.status, error: err.error || `HTTP ${res.status}`, events: [], content: '' };
  }
  const events = [];
  let buf = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const p of parts) {
      for (const line of p.split('\n')) {
        if (line.startsWith('data:')) {
          try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
        }
      }
    }
  }
  const content = events.filter((e) => e.type === 'content').map((e) => e.delta).join('');
  const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.delta).join('');
  const toolCalls = events.filter((e) => e.type === 'tool_call');
  const toolResults = events.filter((e) => e.type === 'tool_result');
  const conversation = events.find((e) => e.type === 'conversation');
  const errEvt = events.find((e) => e.type === 'error');
  return { events, content, reasoning, toolCalls, toolResults, conversationId: conversation?.id, error: errEvt?.message };
}

async function upload(fileName) {
  const buf = fs.readFileSync(path.join(FX, fileName));
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fileName, data: buf.toString('base64') }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const dataUrl = (fileName, mime) =>
  `data:${mime};base64,` + fs.readFileSync(path.join(FX, fileName)).toString('base64');

function extractBlock(text, kind) {
  const m = String(text || '').match(new RegExp('```' + kind + '\\s*\\n([\\s\\S]*?)```'));
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return { __parseError: m[1].slice(0, 100) }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= T1 计划模式 ================= */
async function t1() {
  console.log('\n── T1 计划模式 ──');
  // 1a: 规划模式下不执行工具、输出结构化计划
  const r = await chat({ message: '帮我在工作区建一个简单的个人主页 index.html，包含标题和一段自我介绍', mode: 'plan' });
  const plan = extractBlock(r.content, 'plan');
  const noTools = r.toolCalls.length === 0;
  record('T1a', '规划模式不调用工具', '0 次 tool_call', `${r.toolCalls.length} 次`, noTools, r.error || '');
  record('T1b', '输出结构化计划(\\`\\`\\`plan JSON)', 'JSON 含 title/steps≥2', plan ? `steps=${plan?.steps?.length}` : '未找到 plan 块', Boolean(plan?.steps?.length >= 2), plan ? JSON.stringify(plan).slice(0, 200) : r.content.slice(0, 150));

  // 1c: 确认后执行（模拟点击"按此计划执行"）
  if (plan) {
    const r2 = await chat({ message: `请按以下已确认的计划执行（无需再次确认）：\n${JSON.stringify(plan)}` });
    record('T1c', '确认后执行产生工具调用', '≥1 次 tool_call', `${r2.toolCalls.length} 次`, r2.toolCalls.length >= 1, r2.toolCalls.map((t) => t.name).join(','));
  }
  return r.conversationId;
}

/* ================= T2 图片上传 ================= */
async function t2() {
  console.log('\n── T2 图片上传 ──');
  const cases = [
    ['img_test.png', 'image/png', 'PNG-TEST-2026'],
    ['img_test.jpg', 'image/jpeg', 'JPG-TEST-2026'],
    ['img_test.webp', 'image/webp', 'WEBP-TEST-2026'],
  ];
  for (const [file, mime, keyword] of cases) {
    const r = await chat({ message: '图片里写了什么英文文字？只回答文字内容。', images: [dataUrl(file, mime)], model: VISION_MODEL });
    record(`T2-${file.split('.').pop()}`, `${file.split('.').pop()} 格式识别`, `回答含「${keyword}」`, r.content.trim().slice(0, 80), r.content.includes(keyword), '');
  }
  // 错误用例：非视觉模型
  const e1 = await chat({ message: '看图', images: [dataUrl('img_test.png', 'image/png')], model: TEXT_MODEL });
  record('T2-err-model', '非视觉模型+图片 → 友好报错', 'HTTP 400 且提示切换模型', `${e1.status}: ${e1.error?.slice(0, 80)}`, e1.httpError && e1.status === 400 && /视觉|glm-4v/.test(e1.error || ''), e1.error || '');
  // 错误用例：不支持的格式（gif dataURL）
  const e2 = await chat({ message: '看图', images: ['data:image/gif;base64,R0lGODlhAQABAAAAACw='], model: VISION_MODEL });
  record('T2-err-fmt', 'GIF 格式 → 友好报错', 'HTTP 400 且说明仅支持 PNG/JPG/WEBP', `${e2.status}: ${e2.error?.slice(0, 80)}`, e2.httpError && e2.status === 400 && /PNG/.test(e2.error || ''), e2.error || '');
  // 错误用例：超大图（6MB 随机 PNG 太慢，直接构造超大 base64）
  const big = 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024);
  const e3 = await chat({ message: '看图', images: [big], model: VISION_MODEL });
  record('T2-err-size', '超大图（>5MB）→ 友好报错', 'HTTP 400 且提示大小上限', `${e3.status}: ${e3.error?.slice(0, 80)}`, e3.httpError && e3.status === 400 && /过大/.test(e3.error || ''), e3.error || '');
}

/* ================= T3 文件阅读 ================= */
async function t3() {
  console.log('\n── T3 文件阅读 ──');
  // PDF 文本版
  const pdf = await upload('sample_text.pdf');
  const ex = pdf.body.extraction || {};
  record('T3-pdf-text', 'PDF 文本提取', 'ok, 3 页, 文本含 Hello GLM Agent Chat', `${ex.ok} ${ex.pages}页 ${String(ex.text).slice(0, 60)}`, ex.ok && ex.pages === 3 && /Hello GLM Agent Chat/.test(ex.text || ''), ex.warning || '');
  // 扫描件
  const scan = await upload('sample_scanned.pdf');
  const sx = scan.body.extraction || {};
  record('T3-pdf-scan', '扫描件识别为无文本层（不做 OCR，明确提示）', 'hasText=false + warning 含「扫描件」', `hasText=${sx.hasText} ${String(sx.warning).slice(0, 80)}`, sx.ok && sx.hasText === false && /扫描件/.test(sx.warning || ''), sx.warning || '');
  // Excel
  const xlsx = await upload('sample.xlsx');
  const xx = xlsx.body.extraction || {};
  const sheetOk = (xx.sheetCount === 2) && /销售|库存/.test((xx.sheetNames || []).join()) && /120|月份/.test(xx.text || '') && /合并单元格测试/.test(xx.text || '');
  record('T3-xlsx', 'Excel 多 sheet/公式值/合并单元格', '2 个 sheet，含数据与合并单元格文本', `${xx.summary} | ${String(xx.text).slice(0, 100)}`, Boolean(sheetOk), xx.note || '');
  // FASTA
  const fa = await upload('sample.fasta');
  const fx = fa.body.extraction || {};
  record('T3-fasta', 'FASTA 解析（3 条序列、> 注释、长度/GC）', 'count=3, 含 seq1..seq3 与长度', `${fx.summary} | ${String(fx.text).slice(0, 120)}`, fx.ok && /3 条序列/.test(fx.summary || '') && /seq1|seq2|seq3/.test(fx.text || ''), '');
  // 错误：不允许的类型
  const bad = await fetch(`${BASE}/api/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'evil.exe', data: Buffer.from('MZ').toString('base64') }),
  });
  const badBody = await bad.json().catch(() => ({}));
  record('T3-err-ext', '不允许的类型 → 友好报错', 'HTTP 400 且列出支持类型', `${bad.status}: ${badBody.error?.slice(0, 80)}`, bad.status === 400 && /支持/.test(badBody.error || ''), badBody.error || '');
  // 附件进对话：模型能引用注入内容
  const r = await chat({
    message: '不要调用任何工具，直接根据消息里的附件内容回答：附件第一页的第一句英文是什么？',
    attachments: [{ name: 'sample_text.pdf', path: pdf.body.path, summary: ex.summary, text: ex.text }],
  });
  record('T3-attach', '附件内容注入对话（模型可引用）', `回答含「Hello GLM Agent Chat」`, r.content.trim().slice(0, 120), /Hello GLM Agent Chat/i.test(r.content), '');
}

/* ================= T4 多轮对话 ================= */
async function t4() {
  console.log('\n── T4 多轮对话（上下文 / 指代消解）──');
  let convId;
  const turns = [
    ['记住暗号：西瓜42号，这是我们之间的秘密。', '西瓜'],
    ['暗号里的水果是什么？', '西瓜'],
    ['把暗号里的数字加上10，等于多少？只回答数字。', '52'],
    ['这个结果用汉字怎么写？', '五十二'],
    ['再重复一遍上面那个汉字。', '五十二'],
    ['对话最开始我让你记住的完整暗号是什么？', '西瓜42'],
  ];
  let ok5 = true;
  let detail = [];
  for (let i = 0; i < turns.length; i++) {
    const [msg, expect] = turns[i];
    const r = await chat({ message: msg, conversationId: convId });
    convId = r.conversationId || convId;
    const hit = r.content.includes(expect);
    detail.push(`第${i + 1}轮${hit ? '✓' : '✗(' + r.content.trim().slice(0, 40) + ')'}`);
    if (!hit) ok5 = false;
    await sleep(300);
  }
  record('T4-ctx', '6 轮上下文保持 + 指代消解（"上面那个/最开始"）', '每轮均命中期望关键词', detail.join('，'), ok5, '');
  return convId;
}

/* ================= T5 联网查询 ================= */
async function t5() {
  console.log('\n── T5 联网查询 ──');
  const r = await chat({ message: '用 web_search 工具搜索：DeepSeek Harness 的 GitHub 开源仓库地址是什么？给出可点击的链接。' });
  const call = r.toolCalls.find((t) => t.name === 'web_search');
  const result = r.toolResults.find((t) => t.name === 'web_search');
  const urls = String(result?.output || '').match(/https?:\/\/[^\s)]+/g) || [];
  record('T5-real-call', '真实发起 web_search 工具调用', '出现 tool_call(web_search)', r.toolCalls.map((t) => t.name).join(',') || '无', Boolean(call), JSON.stringify(call?.args || ''));
  record('T5-links', '返回可溯源链接', '结果含 ≥1 个 URL', `${urls.length} 个 URL: ${(urls[0] || '').slice(0, 60)}`, urls.length >= 1, String(result?.output || '').slice(0, 260));
  record('T5-cite', '回答引用来源链接', '回答含 github.com 或 http 链接', r.content.slice(0, 150), /github\.com|https?:\/\//.test(r.content), '');
  return { engineLine: String(result?.output || '').split('\n')[0], urls };
}

/* ================= T6 需求澄清 ================= */
async function t6() {
  console.log('\n── T6 需求不明确时的交互 ──');
  const r = await chat({ message: '帮我处理一下数据' });
  const opts = extractBlock(r.content, 'options');
  const doneMsg = (r.events.find((e) => e.type === 'done') || {}).message || {};
  // 最终提问消息本身不得与工具执行混杂（服务端硬约束保证；前置探索性工具允许）
  const cleanAsk = !(doneMsg.tool_calls || []).length;
  record('T6-ask', '模糊需求 → 输出选项卡片而非瞎猜', '```options JSON 块，≥2 个互斥选项', opts ? `options=${opts.options?.length}: ${JSON.stringify(opts.options || []).slice(0, 120)}` : r.content.slice(0, 120), Boolean(opts?.options?.length >= 2), '');
  record('T6-noexec', '提问消息不与工具执行混杂（先问后做）', '最终提问消息 0 个 tool_calls', `${(doneMsg.tool_calls || []).length} 个（前置探索 ${r.toolCalls.length} 次）`, cleanAsk, '');
  if (opts?.options?.length) {
    const r2 = await chat({ message: `我选择：「${opts.options[0]}」`, conversationId: r.conversationId });
    record('T6-follow', '选择后正常继续执行', '收到明确回答/开始执行', (r2.content || '').slice(0, 80) + (r2.toolCalls.length ? ` (+${r2.toolCalls.length} 次工具)` : ''), Boolean(r2.content || r2.toolCalls.length), '');
  }
}

/* ================= 主流程 ================= */
(async () => {
  console.log(`目标服务: ${BASE}，文本模型: ${TEXT_MODEL}，视觉模型: ${VISION_MODEL}`);
  const only = (process.env.ONLY || '').split(',').filter(Boolean); // 例：ONLY=T6 只跑对应分组
  const t0 = Date.now();
  if (!only.length || only.includes('T1')) await t1();
  if (!only.length || only.includes('T2')) await t2();
  if (!only.length || only.includes('T3')) await t3();
  if (!only.length || only.includes('T4')) await t4();
  const t5ev = !only.length || only.includes('T5') ? await t5() : { engineLine: '(skipped)', urls: [] };
  if (!only.length || only.includes('T6')) await t6();
  const passed = results.filter((r) => r.pass).length;
  console.log('\n════════ 测试汇总 ════════');
  console.log(`通过 ${passed}/${results.length}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('联网证据：', t5ev.engineLine, '|示例URL:', t5ev.urls.slice(0, 3).join(' , '));
  fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), models: { text: TEXT_MODEL, vision: VISION_MODEL }, summary: { passed, total: results.length }, results, webEvidence: { engineLine: t5ev.engineLine, sampleUrls: t5ev.urls.slice(0, 5) } }, null, 2));
  console.log('明细已写入 tests/results.json');
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });
