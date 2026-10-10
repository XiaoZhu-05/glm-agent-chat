/**
 * everyinfra_data 工具验证脚本（自包含，无需启动服务、无需 GLM、无需外网）
 * 用法：node tests/everyinfra_check.mjs
 * 原理：
 *   - 在 127.0.0.1 起一个 mock EveryInfra API（catalog/social/search/jobs 各路径 + 401/404/202 分支）
 *   - 以不同环境变量组合 require server.js（require.main 守卫保证不监听端口），
 *     直接调用 executeTool('everyinfra_data') 走完整请求/落地/分页/异步轮询链路
 * 覆盖：目录查询（免 key）/ 平台目录 404 / 未配 key 友好报错 / key 无效 401 /
 *       同步结果落盘+翻页提示 / page_token 翻页 / 202 异步任务轮询 / search 工具 /
 *       网络不可达提示代理 / TOOLS 注册表 /
 *       内置 CONNECT 代理隧道（http 目标明文、gzip 解压、鉴权透传、CONNECT 被拒）
 * 注：https 目标经代理的 TLS 隧道（真实 Clash + 真实 API）在本机手工验证（见 PR）。
 */
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);
const SERVER_PATH = require.resolve('../server.js');

const results = [];
function record(id, name, expected, actual, pass, evidence = '') {
  results.push({ id, name, pass, expected, actual: String(actual).slice(0, 200), evidence: String(evidence).slice(0, 300) });
  console.log(`${pass ? '✅' : '❌'} [${id}] ${name}`);
  if (!pass) console.log(`   预期: ${expected}\n   实际: ${String(actual).slice(0, 200)}`);
}

/* ---------------- mock EveryInfra API ---------------- */
const state = { jobPolls: 0, socialBodies: [], searchBodies: [], authSeen: new Set(), connects: 0 };

const mockServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  // chunked + gzip 变体：模拟真实 API 的压缩传输，验证代理隧道的解压/分块解析
  const sendGzipChunked = (code, obj) => {
    const buf = zlib.gzipSync(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked' });
    res.write(buf.subarray(0, 10)); // 强制分块
    setTimeout(() => res.end(buf.subarray(10)), 30);
  };
  const auth = req.headers.authorization || '';
  if (auth) state.authSeen.add(auth);

  if (req.method === 'GET' && url.pathname === '/api/v1/social/catalog') {
    const p = url.searchParams.get('platform');
    // 与真实 API 同构：platforms 恒为全量列表，capabilities 按 ?platform= 过滤
    const allPlatforms = ['xiaohongshu', 'douyin', 'bilibili', 'reddit'];
    const allCaps = [
      { platform: 'xiaohongshu', action: 'search', action_label: '关键词搜索', required_params: ['keyword'], optional_params: ['page_token', 'sort'], mode: 'sync', cost_credits: 400, price_cny: 0.037258 },
      { platform: 'xiaohongshu', action: 'note', action_label: '笔记详情', required_params: ['url'], optional_params: [], mode: 'sync', cost_credits: 400, price_cny: 0.037258 },
      { platform: 'douyin', action: 'search', action_label: '关键词搜索', required_params: ['keyword'], optional_params: ['page_token'], mode: 'sync', cost_credits: 400, price_cny: 0.037258 },
    ];
    if (!p) return sendGzipChunked(200, { object: 'social.catalog', platforms: allPlatforms, capabilities: allCaps });
    if (!allPlatforms.includes(p)) return send(404, { error: `platform '${p}' not found` });
    return send(200, { platforms: allPlatforms, capabilities: allCaps.filter((c) => c.platform === p) });
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/search/tools') {
    return send(200, { object: 'search.tools', tools: [{ tool: 'web', description: '网页搜索', required_params: ['q'], optional_params: ['page'], units: 1, price_credits: 50, price_cny: 0.005 }, { tool: 'scholar', description: '学术搜索', required_params: ['q'], optional_params: [], units: 1, price_credits: 50, price_cny: 0.005 }] });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/social') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      state.socialBodies.push({ ...b, __auth: auth });
      if (auth !== 'Bearer test-key') return send(401, { error: 'invalid api key' });
      if (b.action === 'trending') return send(202, { object: 'job', job_id: 'job_e2e001' });
      if (b.params?.page_token === 'pg2') return send(200, { data: [{ tag: '第二页' }], next_page_token: 'pg3' });
      return send(200, { data: [{ note_id: 'n1', title: '测试笔记' }], next_page_token: 'pg2' });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/search') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      state.searchBodies.push({ ...b, __auth: auth });
      if (auth !== 'Bearer test-key') return send(401, { error: 'invalid api key' });
      return send(200, { results: [{ title: 'Mocked result', url: 'https://example.com/1' }] });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/jobs/job_e2e001') {
    state.jobPolls++;
    if (state.jobPolls < 3) return send(200, { object: 'job', status: 'running' });
    return send(200, { object: 'job', status: 'completed', result: { data: [{ hot: '热榜第1条' }] } });
  }
  send(404, { error: 'not mocked' });
});

await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mockServer.address().port}`;
console.log(`mock EveryInfra API: ${MOCK}`);

/* ---------------- mock 本地 CONNECT 代理（模拟 Clash 等） ---------------- */
const connectProxy = net.createServer((socket) => {
  socket.once('data', (buf) => {
    const head = buf.toString('latin1');
    if (!head.startsWith('CONNECT')) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.end(); }
    state.connects++;
    const [host, port] = head.split(/\s+/)[1].split(':');
    const upstream = net.connect(+port, host, () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
});
await new Promise((r) => connectProxy.listen(0, '127.0.0.1', r));
const PROXY = `127.0.0.1:${connectProxy.address().port}`; // 故意不带 scheme，测归一化

// 始终拒绝 CONNECT 的代理（模拟无权限/规则拦截）
const rejectProxy = net.createServer((socket) => {
  socket.once('data', () => { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.end(); });
});
await new Promise((r) => rejectProxy.listen(0, '127.0.0.1', r));
const REJECT_PROXY = `http://127.0.0.1:${rejectProxy.address().port}`;
console.log(`mock CONNECT 代理: ${PROXY}（拒绝代理: ${REJECT_PROXY}）`);

/* ---------------- 用不同 env 组合加载 server.js（不监听端口） ---------------- */
function freshServer(env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[SERVER_PATH];
  return require(SERVER_PATH); // require.main 守卫：不 listen
}

// 记录测试新建的 workspace/everyinfra 文件，收尾清理
const eiDir = path.join(ROOT, 'workspace', 'everyinfra');
const before = new Set(fs.existsSync(eiDir) ? fs.readdirSync(eiDir) : []);
const runTool = (srv, args) => srv.executeTool('everyinfra_data', args).then(
  (out) => ({ ok: true, out }),
  (e) => ({ ok: false, out: e.message }),
);

(async () => {
  let failed = 0;

  /* -- 组合 A：正确 key + mock base url -- */
  const good = freshServer({
    EVERYINFRA_BASE_URL: MOCK,
    EVERYINFRA_API_KEY: 'test-key',
    EVERYINFRA_TIMEOUT_MS: '5000',
    EVERYINFRA_JOB_MAX_WAIT_MS: '15000',
  });

  // E1 免 key 目录（列出平台 + 搜索工具带必填参数）
  const e1 = await runTool(good, { kind: 'catalog' });
  record('E1', 'catalog 免 key 目录（平台+搜索工具）', '含 xiaohongshu 与 web(q)/scholar(q)', e1.out.slice(0, 120), e1.ok && /xiaohongshu/.test(e1.out) && /douyin/.test(e1.out) && /web\(q\)/.test(e1.out) && /scholar\(q\)/.test(e1.out), '');

  // E2 指定平台目录：capabilities 紧凑渲染（动作/必填/可选/价格）
  const e2 = await runTool(good, { kind: 'catalog', platform: 'xiaohongshu' });
  record('E2', 'catalog 指定平台（动作/必填参数/价格紧凑渲染）', '含 search、必填{keyword}、¥0.037', e2.out.slice(0, 160), e2.ok && /search/.test(e2.out) && /\{keyword\}/.test(e2.out) && /¥0\.037/.test(e2.out) && /note/.test(e2.out), '');

  // E3 不存在的平台 → 友好 404
  const e3 = await runTool(good, { kind: 'catalog', platform: 'nonexist' });
  record('E3', 'catalog 未知平台 → 友好报错', '错误含「不存在」+提示先查列表', e3.out.slice(0, 120), !e3.ok && /不存在/.test(e3.out), '');

  // E5 social 同步：落盘 + 翻页提示
  const e5 = await runTool(good, { kind: 'social', platform: 'xiaohongshu', action: 'search', params: { query: '咖啡' } });
  const saved1 = /workspace\/everyinfra\/(\S+\.json)/.exec(e5.out)?.[1];
  record('E5', 'social 同步请求（落盘+预览+翻页提示）', '含「请求成功」「已保存」next_page_token 提示', e5.out.slice(0, 150), e5.ok && /请求成功/.test(e5.out) && /已保存/.test(e5.out) && /next_page_token/.test(e5.out), saved1 || '');
  record('E5b', 'mock 收到的请求体（platform/action/params 透传）', '{platform:"xiaohongshu",action:"search",params.query:"咖啡"}', JSON.stringify(state.socialBodies.at(-1)), state.socialBodies.at(-1)?.platform === 'xiaohongshu' && state.socialBodies.at(-1)?.action === 'search' && state.socialBodies.at(-1)?.params?.query === '咖啡', '');

  // E6 page_token 翻页
  const e6 = await runTool(good, { kind: 'social', platform: 'xiaohongshu', action: 'search', params: { query: '咖啡', page_token: 'pg2' } });
  record('E6', 'page_token 翻页（拿到第二页数据）', '预览含「第二页」且提示 pg3', e6.out.slice(0, 120), e6.ok && /第二页/.test(e6.out) && /pg3/.test(e6.out), '');

  // E7 social 异步：202 → 轮询 → 完成解包 result
  const t7 = Date.now();
  const e7 = await runTool(good, { kind: 'social', platform: 'bilibili', action: 'trending' });
  record('E7', '202 异步任务（job_id 轮询至完成，解包 result）', `含 job_e2e001/热榜第1条，轮询≈3 次（~6s）`, e7.out.slice(0, 120), e7.ok && /job_e2e001/.test(e7.out) && /热榜第1条/.test(e7.out) && state.jobPolls === 3, `耗时${((Date.now() - t7) / 1000).toFixed(0)}s`);

  // E8 search 工具
  const e8 = await runTool(good, { kind: 'search', tool: 'web', params: { query: 'test' } });
  record('E8', 'search 搜索工具（body 透传 tool+params）', '含 Mocked result；mock 收到 tool=web', e8.out.slice(0, 120), e8.ok && /Mocked result/.test(e8.out) && state.searchBodies.at(-1)?.tool === 'web', '');

  // E11 TOOLS 注册表
  const def = good.TOOLS.find((t) => t.function.name === 'everyinfra_data');
  record('E11', 'TOOLS 注册表含 everyinfra_data（4 种 kind）', '定义存在且 enum 含 catalog/social/search/job', def ? def.function.parameters.properties.kind.enum.join(',') : '缺失', Boolean(def) && def.function.parameters.properties.kind.enum.length === 4, '');

  /* -- 组合 B：未配 key → 友好报错（不发请求） -- */
  const nokey = freshServer({ EVERYINFRA_API_KEY: '', EVERYINFRA_BASE_URL: MOCK });
  const b1 = await runTool(nokey, { kind: 'social', platform: 'xiaohongshu', action: 'search' });
  record('E4', '未配 key（social/search）→ 友好报错', '错误含「未配置 EVERYINFRA_API_KEY」+console 指引', b1.out.slice(0, 150), !b1.ok && /未配置 EVERYINFRA_API_KEY/.test(b1.out) && /console\.everyinfra\.com/.test(b1.out), '');

  /* -- 组合 C：错误 key → 401 友好报错 -- */
  const badkey = freshServer({ EVERYINFRA_API_KEY: 'bad-key', EVERYINFRA_BASE_URL: MOCK });
  const c1 = await runTool(badkey, { kind: 'social', platform: 'xiaohongshu', action: 'search' });
  record('E9', 'key 无效（401）→ 友好报错', '错误含「无效或未授权」', c1.out.slice(0, 120), !c1.ok && /无效或未授权/.test(c1.out), '');

  /* -- 组合 D：不可达地址 → 网络错误提示代理 -- */
  const dead = freshServer({ EVERYINFRA_API_KEY: 'test-key', EVERYINFRA_BASE_URL: 'http://127.0.0.1:1' });
  const d1 = await runTool(dead, { kind: 'catalog' });
  record('E10', '网络不可达 → 提示配 EVERYINFRA_PROXY', '错误含「网络请求失败」与代理指引', d1.out.slice(0, 150), !d1.ok && /网络请求失败/.test(d1.out) && /EVERYINFRA_PROXY/.test(d1.out), '');

  /* -- 组合 E：内置 CONNECT 代理隧道（模拟 Clash，地址不带 scheme 测归一化） -- */
  const proxied = freshServer({
    EVERYINFRA_BASE_URL: MOCK,
    EVERYINFRA_API_KEY: 'test-key',
    EVERYINFRA_PROXY: PROXY,
    EVERYINFRA_TIMEOUT_MS: '5000',
    EVERYINFRA_JOB_MAX_WAIT_MS: '15000',
  });
  const connectsBefore = state.connects;
  const socialBefore = state.socialBodies.length;

  // P1 catalog 走代理（gzip + chunked 响应经隧道解压）
  const p1 = await runTool(proxied, { kind: 'catalog' });
  record('P1', 'catalog 走 CONNECT 代理（gzip/chunked 解压）', '含 xiaohongshu/web 且代理 CONNECT 次数增加', p1.out.slice(0, 120), p1.ok && /xiaohongshu/.test(p1.out) && /scholar/.test(p1.out) && state.connects > connectsBefore, `connects=${state.connects - connectsBefore}`);

  // P2 social 走代理：鉴权头经隧道透传到目标
  const p2 = await runTool(proxied, { kind: 'social', platform: 'xiaohongshu', action: 'search', params: { query: '代理' } });
  const lastSocial = state.socialBodies[socialBefore] || {};
  record('P2', 'social 走代理（Authorization 透传 + body 到达）', 'mock 收到 __auth=Bearer test-key 且 query=代理', p2.out.slice(0, 100), p2.ok && lastSocial.__auth === 'Bearer test-key' && lastSocial.params?.query === '代理' && /已保存/.test(p2.out), JSON.stringify(lastSocial).slice(0, 120));

  /* -- 组合 F：代理拒绝 CONNECT → 友好报错 -- */
  const rejected = freshServer({
    EVERYINFRA_BASE_URL: MOCK,
    EVERYINFRA_API_KEY: 'test-key',
    EVERYINFRA_PROXY: REJECT_PROXY,
  });
  const f1 = await runTool(rejected, { kind: 'catalog' });
  record('P3', '代理拒绝 CONNECT（403）→ 友好报错', '错误含「代理 CONNECT 被拒绝」', f1.out.slice(0, 120), !f1.ok && /代理 CONNECT 被拒绝/.test(f1.out), '');

  // P4：代理端口无进程 → 友好报错
  const deadProxy = freshServer({
    EVERYINFRA_BASE_URL: MOCK,
    EVERYINFRA_API_KEY: 'test-key',
    EVERYINFRA_PROXY: 'http://127.0.0.1:1',
  });
  const p4 = await runTool(deadProxy, { kind: 'catalog' });
  record('P4', '代理不可达 → 友好报错（提示检查端口）', '错误含「连接代理超时/失败」', p4.out.slice(0, 150), !p4.ok && /代理/.test(p4.out), '');

  /* ---------------- 收尾 ---------------- */
  failed = results.filter((r) => !r.pass).length;
  console.log('\n════════ everyinfra_check 汇总 ════════');
  console.log(`通过 ${results.length - failed}/${results.length}`);
  // 清理本次测试生成的 workspace/everyinfra 文件
  if (fs.existsSync(eiDir)) {
    for (const f of fs.readdirSync(eiDir)) {
      if (!before.has(f)) { try { fs.unlinkSync(path.join(eiDir, f)); } catch { /* 忽略 */ } }
    }
    if (!fs.readdirSync(eiDir).length) fs.rmSync(eiDir, { recursive: true });
  }
  mockServer.close();
  connectProxy.close();
  rejectProxy.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });
