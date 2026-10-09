/**
 * BioNeMo protein_structure 工具复现脚本
 * 用法：node tests/bionemo_check.mjs [baseUrl]
 * 前置：服务已启动（node server.js）
 * 行为：
 *   - .env 未配置 NVIDIA_API_KEY → 验证「友好报错」路径（预期：工具被调用并返回明确提示）
 *   - 已配置 key → 发起真实 ESMFold 调用（预期：返回结构摘要 + workspace/pdb/*.pdb 落盘）
 */
const BASE = process.argv[2] || 'http://localhost:3210';

const SEQ = 'MVHLTPEEKSAVTALWGKVNVDEVGGEALGRLLVVYPWTQRFF'; // 人 β-珠蛋白片段

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: `用 protein_structure 工具预测这个蛋白质片段的三维结构：${SEQ}`,
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
let toolResult = '';
let answer = '';
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
      if (e.type === 'tool_call' && e.name === 'protein_structure') {
        toolCalled = true;
        console.log('✓ 模型调用了 protein_structure，参数序列长度:', (e.args.sequence || '').length);
      }
      if (e.type === 'tool_result' && e.name === 'protein_structure') {
        toolResult = e.output || '';
        console.log(e.ok ? '✓ 工具返回成功' : '✗ 工具返回错误（可见降级）');
        console.log('--- 工具输出 ---');
        console.log(toolResult.slice(0, 500));
      }
      if (e.type === 'content') answer += e.delta;
    }
  }
}
console.log('--- 模型回答（前 300 字）---');
console.log(answer.trim().slice(0, 300));
console.log('\n结论：', toolCalled
  ? (toolResult.includes('结构预测成功') ? '✅ 真实调用成功（PDB 已落盘）' : '⚠ 工具被调用，返回提示信息（未配置 key 时属预期友好降级）')
  : '❌ 模型未调用该工具');
