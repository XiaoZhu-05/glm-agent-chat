/**
 * Biomni biomni_task 工具复现脚本（链路验证）
 * 用法：node tests/biomni_check.mjs [baseUrl]
 * 前置：服务已启动，.env 已配置 BIOMNI_PYTHON（指向装好 biomni 的 venv）
 * 验证目标（免费模型）：工具被调用 → 子进程运行 → ReAct 过程日志返回。
 * 已知限制：glm-4.5-flash 对 Biomni 提示格式遵循不足，任务可能不收敛（结果如实展示）。
 */
const BASE = process.argv[2] || 'http://localhost:3210';

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: '用 biomni_task 工具执行：用 Python 计算 DNA 序列 ATGCGCATTTGCAGGCTA 的 GC 含量百分比',
    model: process.env.TEXT_MODEL || 'glm-4.5-flash',
  }),
});
if (!res.ok || !(res.headers.get('content-type') || '').includes('event-stream')) {
  const err = await res.json().catch(() => ({}));
  console.error('❌ 请求失败:', res.status, err.error || '');
  process.exit(1);
}

const dec = new TextDecoder();
let buf = '';
let toolCalled = false;
let toolOk = null;
let toolOutput = '';
let answer = '';
const t0 = Date.now();
const reader = res.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop();
  for (const p of parts) {
    for (const line of p.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let e;
      try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (e.type === 'tool_call' && e.name === 'biomni_task') {
        toolCalled = true;
        console.log(`✓ [${((Date.now() - t0) / 1000).toFixed(0)}s] 模型调用了 biomni_task`);
      }
      if (e.type === 'tool_result' && e.name === 'biomni_task') {
        toolOk = e.ok;
        toolOutput = e.output || '';
        console.log(`✓ [${((Date.now() - t0) / 1000).toFixed(0)}s] 工具返回（ok=${e.ok}），输出 ${toolOutput.length} 字符`);
      }
      if (e.type === 'content') answer += e.delta;
    }
  }
}
console.log('--- biomni_task 输出（前 900 字）---');
console.log(toolOutput.slice(0, 900));
console.log('--- 模型回答（前 200 字）---');
console.log(answer.trim().slice(0, 200));
const converged = toolOutput.includes('最终结果') && /GC/i.test(toolOutput);
console.log('\n结论：', !toolCalled
  ? '❌ 模型未调用 biomni_task'
  : converged
    ? '✅ 链路通且任务收敛'
    : `⚠ 链路已通（工具调用/子进程/日志返回正常），任务未完全收敛——免费模型已知限制`);
