/* ============ GLM Agent Chat 前端逻辑 ============ */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const el = {
    chat: $('#chat'),
    chatScroll: $('#chat-scroll'),
    convList: $('#conv-list'),
    newChatBtn: $('#new-chat-btn'),
    convTitle: $('#conv-title'),
    modelSelect: $('#model-select'),
    input: $('#input'),
    inputBox: $('#input-box'),
    sendBtn: $('#send-btn'),
    stopBtn: $('#stop-btn'),
    keyStatus: $('#key-status'),
    workspacePath: $('#workspace-path'),
    planToggle: $('#plan-toggle'),
    attachBtn: $('#attach-btn'),
    attachInput: $('#attach-input'),
    attachBar: $('#attach-bar'),
  };

  const state = {
    config: { model: 'glm-5.3', models: [], hasKey: false, workspace: '' },
    convs: [],
    currentConvId: null,
    streaming: false,
    abortCtrl: null,
    pinned: true,
    planMode: false,
    images: [], // 待发送图片 dataURL 列表
    files: [],  // 待发送文档附件（/api/upload 产物）
  };

  /* ---------------- Markdown ---------------- */

  if (window.marked) {
    marked.setOptions({ breaks: true, gfm: true });
  }

  function mdToHtml(text) {
    if (window.marked) {
      try { return marked.parse(text || ''); } catch { /* fallthrough */ }
    }
    return (text || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  /** 渲染 markdown 并美化代码块（语言标签 + 复制按钮 + 高亮） */
  function renderMarkdownInto(container, text) {
    container.innerHTML = mdToHtml(text);
    container.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      if (!code) return;
      const langMatch = [...code.classList].find((c) => c.startsWith('language-'));
      const lang = langMatch ? langMatch.slice(9) : 'text';

      const wrap = document.createElement('div');
      wrap.className = 'code-block';
      const head = document.createElement('div');
      head.className = 'code-block-head';
      const langSpan = document.createElement('span');
      langSpan.className = 'code-lang';
      langSpan.textContent = lang;
      const copy = document.createElement('button');
      copy.className = 'copy-btn';
      copy.innerHTML = copyIconSvg + '<span>复制</span>';
      copy.addEventListener('click', () => {
        copyText(code.textContent).then(() => {
          copy.querySelector('span').textContent = '已复制';
          setTimeout(() => (copy.querySelector('span').textContent = '复制'), 1500);
        });
      });
      head.append(langSpan, copy);
      pre.parentNode.insertBefore(wrap, pre);
      wrap.append(head, pre);

      if (window.hljs) {
        try { hljs.highlightElement(code); } catch { /* ignore */ }
      }
    });
  }

  function copyText(t) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(t);
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return Promise.resolve();
  }

  const copyIconSvg =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

  /* ---------------- 特殊内容块（options / plan） ---------------- */

  /** 从回答文本中提取 ```options / ```plan 代码块，返回剩余文本与块列表 */
  function extractSpecialBlocks(text) {
    const blocks = [];
    const re = /```(options|plan)\s*\n([\s\S]*?)```/g;
    const clean = String(text || '').replace(re, (m, kind, body) => {
      try {
        blocks.push({ kind, data: JSON.parse(body.trim()) });
        return '';
      } catch { return m; }
    });
    return { clean, blocks };
  }

  /** 渲染回答：Markdown + 特殊卡片（澄清选项等） */
  function renderAnswerContent(container, rawText, opts = {}) {
    const { clean, blocks } = extractSpecialBlocks(rawText);
    renderMarkdownInto(container, clean);
    for (const b of blocks) {
      if (b.kind === 'options') container.appendChild(makeOptionsCard(b.data, opts));
      if (b.kind === 'plan') container.appendChild(makePlanCard(b.data, opts));
    }
  }

  /** 计划卡片：确认前阻塞执行；确认后以执行模式重发，放弃则标记 */
  function makePlanCard(data, opts = {}) {
    const card = document.createElement('div');
    card.className = 'plan-card';
    const head = document.createElement('div');
    head.className = 'plan-head';
    head.innerHTML = `<span class="plan-icon">🧭</span><span class="plan-title"></span><span class="plan-state"></span>`;
    head.querySelector('.plan-title').textContent = data.title || '执行计划';
    card.appendChild(head);

    if (data.goal) {
      const goal = document.createElement('div');
      goal.className = 'plan-goal';
      goal.textContent = '目标：' + data.goal;
      card.appendChild(goal);
    }

    const steps = document.createElement('ol');
    steps.className = 'plan-steps';
    (data.steps || []).forEach((s) => {
      const li = document.createElement('li');
      const a = document.createElement('div');
      a.className = 'ps-action';
      a.textContent = s.action || '';
      if (s.detail) {
        const d = document.createElement('div');
        d.className = 'ps-detail';
        d.textContent = s.detail;
        a.appendChild(d);
      }
      li.appendChild(a);
      steps.appendChild(li);
    });
    card.appendChild(steps);

    if (Array.isArray(data.risks) && data.risks.length) {
      const risks = document.createElement('div');
      risks.className = 'plan-risks';
      risks.innerHTML = '<b>⚠ 风险与注意</b>';
      const ul = document.createElement('ul');
      data.risks.forEach((r) => {
        const li = document.createElement('li');
        li.textContent = r;
        ul.appendChild(li);
      });
      risks.appendChild(ul);
      card.appendChild(risks);
    }

    const stateEl = head.querySelector('.plan-state');
    const setState = (t, cls) => { stateEl.textContent = t; stateEl.className = 'plan-state ' + (cls || ''); };

    if (opts.interactive) {
      const row = document.createElement('div');
      row.className = 'plan-actions';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'plan-ok';
      ok.textContent = '✓ 按此计划执行';
      ok.addEventListener('click', () => {
        setState('已确认', 'ok');
        row.remove();
        if (el.planToggle) { state.planMode = false; el.planToggle.classList.remove('on'); }
        el.input.value = `请按以下已确认的计划执行（无需再次确认）：\n${JSON.stringify(data, null, 2)}`;
        sendMessage('chat');
      });
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'plan-no';
      no.textContent = '✕ 放弃计划';
      no.addEventListener('click', () => {
        setState('已放弃', 'no');
        row.remove();
      });
      row.append(ok, no);
      card.appendChild(row);
    }
    return card;
  }

  /** 澄清选项卡片：单选（点击即发送）/ 多选（勾选后提交）/ 自定义输入 */
  function makeOptionsCard(data, opts = {}) {
    const card = document.createElement('div');
    card.className = 'options-card';
    const q = document.createElement('div');
    q.className = 'opt-q';
    q.textContent = (data.question || '请选择一个方向') + (data.style === 'multi' ? '（可多选）' : '');
    card.appendChild(q);

    const multi = data.style === 'multi';
    const list = document.createElement('div');
    list.className = 'opt-list';
    const btns = [];
    (data.options || []).forEach((o, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'opt-item';
      const box = document.createElement('span');
      box.className = 'opt-box';
      box.textContent = String.fromCharCode(65 + i);
      const label = document.createElement('span');
      label.className = 'opt-label';
      label.textContent = String(o);
      item.append(box, label);
      item.addEventListener('click', () => {
        if (!opts.interactive) return;
        if (multi) {
          item.classList.toggle('sel');
        } else {
          // 单选：点击即确认发送
          el.input.value = `我选择：「${o}」`;
          sendMessage();
        }
      });
      btns.push(item);
      list.appendChild(item);
    });
    card.appendChild(list);

    const row = document.createElement('div');
    row.className = 'opt-actions';
    if (opts.interactive) {
      const custom = document.createElement('input');
      custom.className = 'opt-custom';
      custom.placeholder = '或输入自定义回答…';
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'opt-submit';
      submit.textContent = multi ? '提交多选' : '发送';
      const doSend = () => {
        const sel = btns.filter((b) => b.classList.contains('sel')).map((b) => b.querySelector('.opt-label').textContent);
        const chosen = [...sel, custom.value.trim()].filter(Boolean);
        if (!chosen.length) { custom.focus(); return; }
        el.input.value = (multi ? '我选择（多选）：' : '我选择：') + chosen.map((c) => `「${c}」`).join('、');
        sendMessage();
      };
      submit.addEventListener('click', doSend);
      custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } });
      if (multi) row.append(submit);
      row.append(custom);
      if (!multi) row.append(submit);
    } else {
      card.classList.add('disabled');
      const note = document.createElement('span');
      note.className = 'opt-note';
      note.textContent = '（历史回合中的选项卡片，仅供参考）';
      row.appendChild(note);
    }
    card.appendChild(row);
    return card;
  }

  /* ---------------- 滚动 ---------------- */

  el.chatScroll.addEventListener('scroll', () => {
    const d = el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight;
    state.pinned = d < 60;
  });

  function scrollBottom(force) {
    if (force || state.pinned) el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  }

  /* ---------------- 组件构造 ---------------- */

  const TOOL_META = {
    run_command: { label: '执行命令', prefix: '$ ' },
    read_file: { label: '读取文件' },
    write_file: { label: '写入文件' },
    list_dir: { label: '列出目录' },
    web_search: { label: '联网搜索' },
  };

  function toolCmdText(name, args) {
    args = args || {};
    if (name === 'run_command') return '$ ' + (args.command || '');
    if (name === 'web_search') return '🔍 ' + (args.query || '');
    if (name === 'write_file') return `${args.path || ''}（${String(args.content ?? '').length} 字符）`;
    return args.path || '.';
  }

  function makeThinkCard() {
    const card = document.createElement('div');
    card.className = 'think-card open';
    card.innerHTML = `
      <div class="think-head">
        <span class="t-icon">${brainSvg}</span>
        <span class="t-label">深度思考</span>
        <span class="t-status">正在思考<span class="dots"><i></i><i></i><i></i></span></span>
        <svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="think-body"></div>`;
    card.querySelector('.think-head').addEventListener('click', () => card.classList.toggle('open'));
    card._start = Date.now();
    return card;
  }

  function finishThinkCard(card) {
    if (!card || card._done) return;
    card._done = true;
    const secs = Math.max(1, Math.round((Date.now() - card._start) / 1000));
    card.querySelector('.t-status').textContent = `已深度思考（用时 ${secs} 秒）`;
  }

  const brainSvg =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4a3 3 0 0 0-3 3v0a3 3 0 0 0-2.8 4A3 3 0 0 0 8 17v0a3 3 0 0 0 4 2.8V4z"/><path d="M12 4a3 3 0 0 1 3 3v0a3 3 0 0 1 2.8 4A3 3 0 0 1 16 17v0a3 3 0 0 1-4 2.8"/></svg>';

  function makeToolCard(call) {
    const meta = TOOL_META[call.name] || { label: call.name };
    const card = document.createElement('div');
    card.className = 'tool-card running';
    card.innerHTML = `
      <div class="tool-head">
        <span class="tool-badge">${meta.label}</span>
        <span class="tool-cmd"></span>
        <span class="tool-status">运行中</span>
        <span class="tool-spinner"></span>
        <svg class="tool-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="tool-body"><pre class="tool-output"></pre></div>`;
    card.querySelector('.tool-cmd').textContent = toolCmdText(call.name, call.args);
    card.querySelector('.tool-head').addEventListener('click', (e) => {
      if (e.target.closest('.tool-status')) return;
      card.classList.toggle('open');
    });
    return card;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fillToolResult(card, callName, ok, output) {
    card.classList.remove('running');
    const spin = card.querySelector('.tool-spinner');
    if (spin) spin.remove();
    const status = card.querySelector('.tool-status');
    status.textContent = ok ? '✓ 完成' : '✗ 出错';
    if (!ok) card.querySelector('.tool-badge').classList.add('err');
    const pre = card.querySelector('.tool-output');
    if (callName === 'web_search' && ok && output) {
      // 搜索结果渲染为可点击的溯源链接
      const div = document.createElement('div');
      div.className = 'tool-output html';
      div.innerHTML = escapeHtml(output)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\n/g, '<br>');
      pre.replaceWith(div);
    } else {
      pre.textContent = output || '(无输出)';
    }
    if ((output || '').length <= 400) card.classList.add('open');
  }

  function makeAgentTurn() {
    const wrap = document.createElement('div');
    wrap.className = 'msg-agent';
    const avatar = document.createElement('div');
    avatar.className = 'avatar-agent';
    avatar.textContent = 'GLM';
    const body = document.createElement('div');
    body.className = 'agent-body';
    const name = document.createElement('div');
    name.className = 'agent-name';
    name.textContent = 'GLM Agent';
    body.appendChild(name);
    wrap.append(avatar, body);
    return { wrap, body };
  }

  function makeUserBubble(text, images = [], files = []) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    if (files.length) {
      const list = document.createElement('div');
      list.className = 'bubble-files';
      for (const f of files) {
        const chip = document.createElement('div');
        chip.className = 'file-chip small' + (f.extraction?.ok === false ? ' err' : '');
        chip.textContent = `📄 ${f.name}${f.extraction?.summary ? ' · ' + f.extraction.summary : ''}`;
        if (f.extraction?.warning) chip.title = f.extraction.warning;
        list.appendChild(chip);
      }
      bubble.appendChild(list);
    }
    if (images.length) {
      const grid = document.createElement('div');
      grid.className = 'bubble-images';
      for (const src of images) {
        const img = document.createElement('img');
        img.src = src;
        img.loading = 'lazy';
        img.addEventListener('click', () => window.open(src, '_blank'));
        grid.appendChild(img);
      }
      bubble.appendChild(grid);
    }
    const avatar = document.createElement('div');
    avatar.className = 'avatar-user';
    avatar.textContent = '我';
    wrap.append(bubble, avatar);
    return wrap;
  }

  function makeAnswerDiv() {
    const d = document.createElement('div');
    d.className = 'answer-md streaming';
    return d;
  }

  function makeActions(getText) {
    const row = document.createElement('div');
    row.className = 'agent-actions';
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.innerHTML = copyIconSvg + '<span>复制</span>';
    btn.addEventListener('click', () => {
      copyText(getText()).then(() => {
        btn.querySelector('span').textContent = '已复制';
        setTimeout(() => (btn.querySelector('span').textContent = '复制'), 1500);
      });
    });
    row.appendChild(btn);
    return row;
  }

  /* ---------------- 历史会话渲染 ---------------- */

  function renderConversation(conv) {
    el.chat.innerHTML = '';
    if (!conv || !conv.messages.length) { renderEmptyState(); return; }

    let agentBody = null;      // 当前用户回合对应的 agent 容器
    let lastAnswer = null;     // 最近一个 answer div（用于追加操作按钮）

    for (const msg of conv.messages) {
      if (msg.role === 'user') {
        el.chat.appendChild(makeUserBubble(msg.content, msg.images || [], msg.attachments || []));
        agentBody = null;
      } else if (msg.role === 'assistant') {
        if (!agentBody) {
          const turn = makeAgentTurn();
          agentBody = turn.body;
          lastAnswer = null;
          el.chat.appendChild(turn.wrap);
        }
        if (msg.reasoning) {
          const card = makeThinkCard();
          card.querySelector('.think-body').textContent = msg.reasoning;
          finishThinkCard(card);
          card.classList.remove('open');
          agentBody.appendChild(card);
        }
        for (const call of msg.tool_calls || []) {
          const card = makeToolCard(call);
          const toolMsg = (conv.messages || []).find((t) => t.role === 'tool' && t.tool_call_id === call.id);
          if (toolMsg) fillToolResult(card, call.name, toolMsg.ok !== false, toolMsg.content);
          else fillToolResult(card, call.name, true, '(运行中)');
          agentBody.appendChild(card);
        }
        if (msg.content) {
          const answer = makeAnswerDiv();
          answer.classList.remove('streaming');
          renderAnswerContent(answer, msg.content, { interactive: false });
          agentBody.appendChild(answer);
          lastAnswer = answer;
        }
      }
    }
    if (lastAnswer) lastAnswer.appendChild(makeActions(() => lastAnswer.textContent));
    scrollBottom(true);
  }

  function renderEmptyState() {
    el.chat.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
      <div class="empty-logo">GLM</div>
      <h2>你好，我是 GLM Agent</h2>
      <p class="sub">我能深度思考，还可以在本地工作区里执行命令、读写文件来完成你的任务。</p>
      <div class="suggest-grid">
        <div class="suggest-card" data-q="看看当前工作区里有哪些文件，并简单介绍一下这个项目">
          <div class="s-title">🗂 查看工作区</div>
          <div class="s-desc">列出工作区的文件并了解项目结构</div>
        </div>
        <div class="suggest-card" data-q="用 Python 计算 100 以内的所有素数，把结果保存到工作区的 primes.txt，然后告诉我一共有多少个">
          <div class="s-title">🧮 跑一段代码</div>
          <div class="s-desc">执行命令并把结果保存为文件</div>
        </div>
        <div class="suggest-card" data-q="在工作区创建一个 hello.txt，写入一句问候语，然后读取出来给我看">
          <div class="s-title">📝 文件读写</div>
          <div class="s-desc">创建文件并验证内容</div>
        </div>
        <div class="suggest-card" data-q="你是谁？你的能力和工作方式是什么？">
          <div class="s-title">💬 自我介绍</div>
          <div class="s-desc">了解这个 Agent 能做些什么</div>
        </div>
      </div>`;
    div.querySelectorAll('.suggest-card').forEach((c) =>
      c.addEventListener('click', () => {
        el.input.value = c.dataset.q;
        sendMessage();
      })
    );
    el.chat.appendChild(div);
  }

  /* ---------------- 侧边栏 ---------------- */

  function renderConvList() {
    el.convList.innerHTML = '';
    for (const c of state.convs) {
      const item = document.createElement('div');
      item.className = 'conv-item' + (c.id === state.currentConvId ? ' active' : '');
      const title = document.createElement('span');
      title.className = 'conv-title';
      title.textContent = c.title || '新对话';
      const del = document.createElement('button');
      del.className = 'conv-del';
      del.title = '删除对话';
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除对话「${c.title}」？`)) return;
        await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
        state.convs = state.convs.filter((x) => x.id !== c.id);
        if (state.currentConvId === c.id) newChat();
        renderConvList();
      });
      item.append(title, del);
      item.addEventListener('click', () => loadConversation(c.id));
      el.convList.appendChild(item);
    }
  }

  async function refreshConvList() {
    try {
      state.convs = await (await fetch('/api/conversations')).json();
      renderConvList();
    } catch { /* ignore */ }
  }

  async function loadConversation(id) {
    if (state.streaming) return;
    try {
      const conv = await (await fetch(`/api/conversations/${id}`)).json();
      if (conv.error) return;
      state.currentConvId = id;
      el.convTitle.textContent = conv.title || '新对话';
      renderConversation(conv);
      renderConvList();
    } catch { /* ignore */ }
  }

  function newChat() {
    if (state.streaming) stopStreaming();
    state.currentConvId = null;
    el.convTitle.textContent = '新的对话';
    renderEmptyState();
    renderConvList();
    el.input.focus();
  }

  /* ---------------- 发送与 SSE 流式接收 ---------------- */

  function setStreaming(on) {
    state.streaming = on;
    el.sendBtn.disabled = on;
    el.stopBtn.hidden = !on;
    el.input.disabled = false;
  }

  function stopStreaming() {
    if (state.abortCtrl) state.abortCtrl.abort();
    setStreaming(false);
  }

  async function sendMessage(modeOverride) {
    const text = el.input.value.trim();
    const images = state.images.slice();
    const files = state.files.slice();
    if (!text && !images.length && !files.length) return;
    if (state.streaming) return;
    const mode = modeOverride === 'chat' || modeOverride === 'plan' ? modeOverride : state.planMode ? 'plan' : 'chat';

    // 客户端预校验图片（服务端仍会兜底校验）
    if (images.length && !(state.config.visionModels || []).includes(el.modelSelect.value)) {
      toast(`当前模型 ${el.modelSelect.value} 不支持图片，请切换到 glm-4v-flash 等视觉模型`, 'error');
      return;
    }

    // 清掉空状态 / 追加用户气泡
    if (!el.chat.querySelector('.msg-user, .msg-agent')) el.chat.innerHTML = '';
    el.chat.appendChild(makeUserBubble(text, images, files));
    el.input.value = '';
    state.images = [];
    state.files = [];
    renderAttachBar();
    autoGrow();
    scrollBottom(true);

    // 创建 agent 回复容器
    const turn = makeAgentTurn();
    el.chat.appendChild(turn.wrap);
    scrollBottom(true);

    let thinkCard = null;
    let answerDiv = null;
    let answerText = '';
    let rafPending = false;

    const ensureThink = () => {
      if (thinkCard && !thinkCard._closed) return thinkCard;
      if (thinkCard) finishThinkCard(thinkCard);
      thinkCard = makeThinkCard();
      turn.body.appendChild(thinkCard);
      scrollBottom();
      return thinkCard;
    };
    const closeThink = () => {
      if (thinkCard && !thinkCard._closed) {
        finishThinkCard(thinkCard);
        thinkCard._closed = true;
        thinkCard.classList.remove('open'); // 收起，像 DeepSeek/GLM 网页版
      }
    };
    const ensureAnswer = () => {
      closeThink();
      if (!answerDiv) {
        answerDiv = makeAnswerDiv();
        turn.body.appendChild(answerDiv);
      }
      return answerDiv;
    };
    const renderAnswerSoon = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (!answerDiv) return;
        renderMarkdownInto(answerDiv, answerText);
        scrollBottom();
      });
    };

    setStreaming(true);
    state.abortCtrl = new AbortController();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationId: state.currentConvId,
          model: el.modelSelect.value || state.config.model,
          mode,
          images,
          attachments: files.map((f) => ({
            name: f.name,
            path: f.path,
            summary: f.extraction?.summary || '',
            text: f.extraction?.text || '',
          })),
        }),
        signal: state.abortCtrl.signal,
      });

      if (!res.ok || !(res.headers.get('content-type') || '').includes('event-stream')) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop();
        for (const block of blocks) {
          let evt = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) {
              try { evt = JSON.parse(line.slice(5).trim()); } catch { /* ignore */ }
            }
          }
          if (!evt) continue;
          handleEvent(evt);
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        const box = document.createElement('div');
        box.className = 'error-box';
        box.textContent = '出错了：' + e.message;
        turn.body.appendChild(box);
      }
    } finally {
      closeThink();
      if (answerDiv) {
        answerDiv.classList.remove('streaming');
        renderAnswerContent(answerDiv, answerText, { interactive: true });
        if (answerText.trim()) answerDiv.appendChild(makeActions(() => answerText));
      }
      setStreaming(false);
      refreshConvList();
      scrollBottom();
    }

    function handleEvent(evt) {
      switch (evt.type) {
        case 'conversation':
          state.currentConvId = evt.id;
          el.convTitle.textContent = evt.title || '新对话';
          break;
        case 'reasoning': {
          const card = ensureThink();
          card.querySelector('.think-body').textContent += evt.delta;
          scrollBottom();
          break;
        }
        case 'content':
          answerText += evt.delta;
          ensureAnswer();
          renderAnswerSoon();
          break;
        case 'tool_call': {
          closeThink();
          const card = makeToolCard(evt);
          turn.body.appendChild(card);
          scrollBottom(true);
          break;
        }
        case 'tool_result': {
          const cards = turn.body.querySelectorAll('.tool-card.running');
          const card = cards[cards.length - 1];
          if (card) fillToolResult(card, evt.name, evt.ok, evt.output);
          scrollBottom();
          break;
        }
        case 'step':
          break;
        case 'error': {
          const box = document.createElement('div');
          box.className = 'error-box';
          box.textContent = '模型调用出错：' + (evt.message || '未知错误');
          turn.body.appendChild(box);
          break;
        }
        case 'done':
          break;
      }
    }
  }

  /* ---------------- 附件上传（图片 / 文档） ---------------- */

  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const IMAGE_MAX_MB = 5;
  const DOC_EXTS = ['.pdf', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json', '.fasta', '.fa', '.fas'];

  function toast(msg, kind = 'info') {
    let host = document.querySelector('#toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 300); }, 3500);
  }

  function renderAttachBar() {
    const bar = el.attachBar;
    bar.innerHTML = '';
    const items = [
      ...state.images.map((src, i) => ({ kind: 'image', src, i })),
      ...state.files.map((f, i) => ({ kind: 'file', f, i })),
    ];
    bar.hidden = items.length === 0;
    for (const it of items) {
      if (it.kind === 'image') {
        const chip = document.createElement('div');
        chip.className = 'img-chip';
        const img = document.createElement('img');
        img.src = it.src;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'img-del';
        del.textContent = '×';
        del.title = '移除图片';
        del.addEventListener('click', () => { state.images.splice(it.i, 1); renderAttachBar(); });
        chip.append(img, del);
        bar.appendChild(chip);
      } else {
        const f = it.f;
        const chip = document.createElement('div');
        chip.className = 'file-chip' + (f.extraction?.ok === false ? ' err' : '');
        const icon = document.createElement('span');
        icon.className = 'fc-icon';
        icon.textContent = '📄';
        const info = document.createElement('div');
        info.className = 'fc-info';
        const nm = document.createElement('div');
        nm.className = 'fc-name';
        nm.textContent = f.name;
        const sm = document.createElement('div');
        sm.className = 'fc-summary';
        sm.textContent = f.extraction?.ok === false
          ? (f.extraction.error || '解析失败')
          : `${f.extraction?.summary || ''}${f.extraction?.warning ? ' ⚠' : ''}`;
        info.append(nm, sm);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'img-del';
        del.textContent = '×';
        del.title = '移除附件';
        del.addEventListener('click', () => { state.files.splice(it.i, 1); renderAttachBar(); });
        chip.append(icon, info, del);
        if (f.extraction?.warning) chip.title = f.extraction.warning;
        bar.appendChild(chip);
      }
    }
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('读取文件失败'));
      r.readAsDataURL(file);
    });
  }

  async function uploadDocument(file) {
    const data = await readAsDataURL(file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, mimeType: file.type, data }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `上传失败（HTTP ${res.status}）`);
    return out; // {name, path, size, extraction}
  }

  el.attachBtn?.addEventListener('click', () => el.attachInput.click());
  el.attachInput?.addEventListener('change', async () => {
    const files = [...(el.attachInput.files || [])];
    el.attachInput.value = '';
    for (const f of files) {
      const isImage = IMAGE_TYPES.includes(f.type);
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
      if (!isImage && !DOC_EXTS.includes(ext)) {
        toast(`「${f.name}」类型不支持（图片：PNG/JPG/WEBP；文档：${DOC_EXTS.join('/')}）`, 'error');
        continue;
      }
      if (isImage) {
        if (f.size > IMAGE_MAX_MB * 1024 * 1024) {
          toast(`「${f.name}」过大（${(f.size / 1048576).toFixed(1)}MB），单张上限 ${IMAGE_MAX_MB}MB`, 'error');
          continue;
        }
        if (state.images.length >= 4) { toast('单条消息最多 4 张图片', 'error'); break; }
        try {
          state.images.push(await readAsDataURL(f));
        } catch (e) { toast(`「${f.name}」${e.message}`, 'error'); }
      } else {
        if (state.files.length >= 4) { toast('单条消息最多 4 个文档', 'error'); break; }
        if (f.size > 10 * 1024 * 1024) { toast(`「${f.name}」过大（上限 10MB）`, 'error'); continue; }
        try {
          const out = await uploadDocument(f);
          state.files.push(out);
          if (out.extraction?.ok === false) toast(`「${f.name}」${out.extraction.error}`, 'error');
          else if (out.extraction?.warning) toast(`「${f.name}」${out.extraction.warning}`, 'info');
        } catch (e) {
          toast(`「${f.name}」${e.message}`, 'error');
        }
      }
    }
    renderAttachBar();
  });

  /* ---------------- 输入框 ---------------- */

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px';
  }

  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  el.sendBtn.addEventListener('click', () => sendMessage());
  el.stopBtn.addEventListener('click', stopStreaming);
  el.newChatBtn.addEventListener('click', newChat);
  el.planToggle?.addEventListener('click', () => {
    state.planMode = !state.planMode;
    el.planToggle.classList.toggle('on', state.planMode);
    el.input.placeholder = state.planMode
      ? '规划模式：描述任务，Agent 会先给出计划等你确认'
      : '给 GLM Agent 发送消息，例如：看看工作区里有什么文件';
  });

  /* ---------------- 初始化 ---------------- */

  async function init() {
    try {
      state.config = await (await fetch('/api/config')).json();
      state.config.visionModels = state.config.visionModels || ['glm-4v-flash'];
    } catch {
      state.config = { model: 'glm-5.3', models: ['glm-5.3'], hasKey: false, workspace: '', visionModels: ['glm-4v-flash'] };
    }

    // 模型下拉
    const saved = localStorage.getItem('glm-model');
    for (const m of state.config.models || []) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      el.modelSelect.appendChild(opt);
    }
    el.modelSelect.value =
      saved && state.config.models.includes(saved) ? saved : state.config.model;
    el.modelSelect.addEventListener('change', () => localStorage.setItem('glm-model', el.modelSelect.value));

    // Key 状态
    if (state.config.hasKey) {
      el.keyStatus.textContent = 'API 已连接';
      el.keyStatus.classList.add('ok');
    } else {
      el.keyStatus.textContent = '未配置 API Key（.env）';
      el.keyStatus.classList.add('bad');
    }

    // 工作区路径
    if (state.config.workspace) {
      el.workspacePath.textContent = state.config.workspace;
      $('#workspace-row').title = state.config.workspace;
    }

    await refreshConvList();
    renderEmptyState();
    el.input.focus();
  }

  init();
})();
