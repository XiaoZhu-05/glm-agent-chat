# GLM Agent Chat

一个 **DeepSeek-Harness 风格**的网页 Agent 对话框：界面参照 GLM 网页版，后端通过
GLM 开放平台（智谱 BigModel）的 OpenAI 兼容接口驱动 `glm` 系列模型，内置 Agent
工具循环（执行命令 / 读写文件），并实时展示**思考链（深度思考）**与**命令/工具调用过程**。

![tech](https://img.shields.io/badge/Node.js-%E2%89%A518-zero--dependency-339933) ![license](https://img.shields.io/badge/license-MIT-blue)

## ✨ 功能特性

- 💬 **网页对话** —— GLM 网页版风格 UI：多会话侧边栏、Markdown 渲染、代码高亮、一键复制
- 🧠 **思考链展示** —— 流式展示模型 `reasoning_content`，折叠式“深度思考”卡片，显示思考用时
- 🛠 **工具调用（Harness）** —— Agent 可在本地工作区中：
  - `run_command`：执行 shell 命令（Windows / macOS / Linux）
  - `read_file` / `write_file` / `list_dir`：读写工作区文件（路径越界保护）
  - 每次调用都会以命令卡片形式展示命令与输出
- 🌊 **全链路流式** —— SSE 推送：思考 → 工具 → 回答，支持随时停止生成
- 🗂 **会话持久化** —— 服务端 JSON 存储，刷新页面不丢历史
- ⚙️ **模型切换** —— 顶栏下拉切换 `glm-5.3` / `glm-4.6` / `glm-4.5-flash` 等
- 📦 **零依赖后端** —— 纯 Node.js 内置模块，`marked` / `highlight.js` 已本地 vendored，离线可用

## 🚀 快速开始

```bash
# 1. 安装 Node.js ≥ 18（无需 npm install，后端零依赖）

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入你的 GLM_API_KEY（https://open.bigmodel.cn 获取）

# 3. 启动
node server.js          # 或 npm start

# 4. 打开浏览器
# http://localhost:3210
```

## ⚙️ 配置说明（.env）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GLM_API_KEY` | （必填） | 智谱开放平台 API Key |
| `GLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | OpenAI 兼容接口地址（可换成 `https://api.z.ai/api/paas/v4`） |
| `GLM_MODEL` | `glm-5.3` | 默认模型 |
| `GLM_MODELS` | `glm-5.3,glm-4.6,...` | 界面可切换的模型列表 |
| `PORT` | `3210` | 服务端口 |
| `AGENT_MAX_STEPS` | `8` | 单轮对话最大工具调用步数 |
| `CMD_TIMEOUT_MS` | `30000` | 单条命令超时 |
| `MAX_TOOL_OUTPUT` | `6000` | 工具输出最大字符数（超出截断） |

> 模型可用性取决于账号余额/资源包：`glm-5.3` 等旗舰模型需要充值；
> `glm-4.5-flash`、`glm-4-flash` 通常有免费额度，可用于体验完整功能（含思考链）。

## 🏗 架构

```
浏览器                     server.js（Node, 零依赖）
┌──────────────┐   HTTP/SSE  ┌─────────────────────────────┐
│ public/      │ ──────────► │ /api/chat  Agent 循环(harness)│
│  index.html  │             │   ├─ GLM chat/completions    │──► GLM 开放平台
│  app.js      │ ◄────────── │   │   (stream + reasoning)   │     (glm-5.3)
│  style.css   │  reasoning/ │   ├─ 工具执行                 │──► 本地 workspace/
│  vendor/     │  content/   │   │   run_command / file io  │
│  (marked+hljs)│ tool_call…  │   └─ 多步循环 (max 8)        │
└──────────────┘             │ /api/conversations 会话存储   │──► data/conversations.json
                             │ 静态文件服务                  │
                             └─────────────────────────────┘
```

一次提问的完整链路：

1. 前端 `POST /api/chat`，建立 SSE 连接
2. 服务端带着系统提示与工具定义请求 GLM（`stream: true`）
3. `reasoning_content` 增量 → 前端"深度思考"卡片流式展开
4. 模型发起 `tool_calls`（如执行命令）→ 服务端在 `workspace/` 中执行 → 结果回传模型
5. 循环直到模型给出最终回答 → 前端 Markdown 渲染

## 🔒 安全说明

- API Key 只存在于 `.env`（已被 `.gitignore` 忽略），前端只拿到"已配置"状态
- 文件工具做了**工作区路径限制**，不能读写 `workspace/` 之外的文件
- `run_command` 在 `workspace/` 目录下执行，超时 30s，输出截断
- 会话数据保存在 `data/`（不入库）

## 📜 License

[MIT](LICENSE)
