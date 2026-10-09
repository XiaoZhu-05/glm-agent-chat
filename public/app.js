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
  };

  const state = {
    config: { model: 'glm-5.3', models: [], hasKey: false, workspace: '' },
    convs: [],
    currentConvId: null,
    streaming: false,
    abortCtrl: null,
    pinned: true,
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
    }
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
  };

  function toolCmdText(name, args) {
    args = args || {};
    if (name === 'run_command') return '$ ' + (args.command || '');
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

  function fillToolResult(card, ok, output) {
    card.classList.remove('running');
    const spin = card.querySelector('.tool-spinner');
    if (spin) spin.remove();
    const status = card.querySelector('.tool-status');
    status.textContent = ok ? '✓ 完成' : '✗ 出错';
    if (!ok) card.querySelector('.tool-badge').classList.add('err');
    card.querySelector('.tool-output').textContent = output || '(无输出)';
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

  function makeUserBubble(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
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
        el.chat.appendChild(makeUserBubble(msg.content));
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
          if (toolMsg) fillToolResult(card, toolMsg.ok !== false, toolMsg.content);
          else fillToolResult(card, true, '(运行中)');
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

  async function sendMessage() {
    const text = el.input.value.trim();
    if (!text || state.streaming) return;

    // 清掉空状态 / 追加用户气泡
    if (!el.chat.querySelector('.msg-user, .msg-agent')) el.chat.innerHTML = '';
    el.chat.appendChild(makeUserBubble(text));
    el.input.value = '';
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
          if (card) fillToolResult(card, evt.ok, evt.output);
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

  el.sendBtn.addEventListener('click', sendMessage);
  el.stopBtn.addEventListener('click', stopStreaming);
  el.newChatBtn.addEventListener('click', newChat);

  /* ---------------- 初始化 ---------------- */

  async function init() {
    try {
      state.config = await (await fetch('/api/config')).json();
    } catch {
      state.config = { model: 'glm-5.3', models: ['glm-5.3'], hasKey: false, workspace: '' };
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
