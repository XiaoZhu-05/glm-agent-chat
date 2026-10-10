# 学习笔记：Agent 是怎么调用网站能力的？

> 讨论背景：EveryInfra（万有引力）控制台的「接入与凭据 → MCP / SDK」页面引出的问题。
> 项目实例：glm-agent-chat 中的 `everyinfra_data` 工具（server.js）。

---

## 〇、先补几个基础概念（新人必看）

| 名词 | 一句话解释 |
|---|---|
| **API** | 网站把能力开放出来的"服务窗口"，程序通过它获取数据或执行操作 |
| **HTTP / REST API** | 最通用的 API 形式：程序发一个 HTTP 请求（如 POST），网站返回数据（通常是 JSON） |
| **API Key** | 一串密钥（如 `sk-xxx`），放在请求头里，作用是**认证身份 + 划定权限 + 计费记账**。它本身不提供任何能力，只是"钥匙" |
| **SDK** | 官方把 REST API 包装成编程语言的函数库（如 Python/JS），你调函数而不用自己拼 HTTP 请求 |
| **MCP** | 一种行业标准协议（Model Context Protocol），把网站能力包装成"工具服务器"，任何支持 MCP 的 AI 客户端（ZCode、Claude Desktop 等）都能直接挂载使用 |
| **Function Calling** | LLM 的工具调用机制：先注册工具（名字+描述+参数），LLM 看到用户需求后自己决定调哪个、传什么参数 |

> ⚠️ **新手常见误区**：API Key 和 SDK/MCP 不是并列关系！
> **能力本体 = REST API，API Key = 钥匙（三条路都要带），SDK 和 MCP = 两条不同的"封装路"**。
> 就连 MCP 的配置里也要先创建 API Key——钥匙不是路。

---

## 一、我的 Agent 是如何调用网站的？

### 三条路全景图

```
能力本体：网站的 HTTP API（REST 接口）   ← 唯一真正干活的地方
    ├── 路 1：直接调 REST API（自己拼请求）
    ├── 路 2：SDK（官方函数库帮你拼）
    └── 路 3：MCP（标准协议工具服务器）

无论走哪条路，请求头里都带着 API Key 这把钥匙 🔑
```

### 我的项目走的是：路 1 + 自己手写封装层

以 glm-agent-chat 里的 `everyinfra_data` 工具为例，完整链路：

```
用户提问 → LLM 决定调用工具（function calling）
              ↓
      everyinfra_data（我手写的封装层，≈ 自制迷你 SDK）
        · 拼 URL + 附加 Authorization: Bearer sk-xxx 请求头
        · 超时控制、异步任务轮询、结果保存文件
              ↓
      EveryInfra 的 REST API（https://api.everyinfra.com）
```

### 分层拆解（对应 server.js 里的代码）

1. **认证层**：API Key 存在 `.env` 文件里（server.js:68），每次请求以 `Authorization: Bearer` 头发出（server.js:729）。
   📌 *知识扩展*：`.env` 存密钥、代码里只读环境变量，是防止密钥被提交到 git 泄露的标准做法。
2. **调用层**：用 Node.js 原生 `fetch` 直接发 HTTP 请求（server.js:724-740），不用任何第三方库；连代理都是用内置 http 模块手写的 CONNECT 隧道（server.js:625）。
3. **暴露层**：把工具注册给 LLM（server.js:235），LLM 通过 function calling 调用（server.js:292 分发），服务端执行后把结果还给 LLM 组织回答。

> 💡 **理解要点**：MCP 做的就是这件事的"标准化版本"——把工具层抽出来做成通用协议，让任何客户端免开发直接用。而 function calling 是各家 agent 框架自己的工具格式，效果一样，协议不同。

---

## 二、为什么不使用网站自带的 SDK 或 MCP？

### 理由 1：项目坚持"零依赖"，而 SDK/MCP 客户端都是依赖

- 我的 server.js **没装任何 npm 包**，标准 Node 环境 `node server.js` 直接跑。
- 引入 SDK 意味着：package.json、node_modules、版本升级维护、**供应链风险**。

> 📌 *知识扩展*：**供应链风险** = 你依赖的第三方包如果被黑客投毒、停止维护或有漏洞，你的项目会跟着遭殃。依赖越少，项目越稳、越可控。
> 而 SDK 换来的只是"帮你拼 URL 和请求头"——这件事十几行代码就能做。

### 理由 2：我的 agent 框架是自建的 function calling，不认识 MCP 协议

- MCP 的前提是**客户端支持 MCP 协议**（如 ZCode、Claude Desktop、Cursor）。
- 我要用 MCP 就得：装 MCP 客户端库 + 额外跑一个 MCP server 进程。链路从 2 跳变 4 跳：

```
现在：  LLM → 工具函数 → REST API          （2 跳，全在自己进程里）
改MCP： LLM → 工具函数 → MCP客户端 → MCP服务器 → REST API  （4 跳 + 多一个进程）
```

> 📌 *知识扩展*：每多一跳、多一个进程，就多一个可能出故障的点。为只用 4 个接口的单一服务多养一个进程——故障点变多，收益为零。

### 理由 3（最关键）：封装层的真正价值，SDK 根本帮不了

我手写的封装层里，真正值钱的是**业务逻辑**，这些任何官方 SDK 都不会替你写：

- 💰 成本护栏：付费调用前拦截检查，防止乱花钱
- ⏱️ 120 秒超时：对齐官方接口的同步响应窗口
- 🔄 异步任务轮询：超时后可用 `job_id` 续查，结果不丢
- 💾 结果自动存档：完整 JSON 落盘到 `everyinfra/` 目录，返回预览+翻页 token
- 🇨🇳 友好报错：401/402/403 时用中文直接告诉你"去 Billing 页充值还是检查 key"

**结论**：就算引入 SDK，上面这层还是得手写——只是把最底下的 `fetch` 换成 `sdk.xxx()`，省的功夫很少，背的依赖不少，不划算。

---

## 三、决策小结：什么时候该换路？

| 场景 | 推荐方案 |
|---|---|
| 单一服务、几个接口、自建 agent 框架 | ✅ 直连 REST + 手写封装（**当前选择**） |
| 要接很多外部服务 / 想让现成 MCP 客户端免开发使用 | 抽成 MCP server |
| 大代码库、多人维护、需要类型定义和统一重试 | 用官方 SDK |

> 🎯 **一句话总结**：**能力在 API，Key 管认证，SDK/MCP 只是封装方式。选路看场景——小而美的项目，直连 REST 是最小、最可控、最干净的方案。**
