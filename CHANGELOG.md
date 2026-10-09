# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号语义见 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-10-09 —— 工具接入版（v0.3.0-tools）

依据《BioNeMo与Biomni集成调研报告.md》实施，硬约束：零部署、零后端运维、不下载大数据、不产生费用。

### 新增

- **`protein_structure` 工具（BioNeMo / NVIDIA NIM 云端 ESMFold）**：蛋白质三维结构预测。FASTA 自动清洗、长度/字母表校验、PDB 落盘 `workspace/pdb/`、401/429/超时分类友好提示；前端复用工具卡片，零改动。
- **`biomni_task` 工具（Stanford Biomni 生物医学子 agent）**：独立 venv 子进程沙箱（主进程零依赖、零 eval）、cwd 锁定 `workspace/biomni`、跳过 11GB 数据湖、GLM 兼容端点驱动、300s 超时父进程终止并返回过程日志。
- 复现脚本：`tests/bionemo_check.mjs`、`tests/biomni_check.mjs`。

### 已验证 / 未验证项（如实）

- ✅ 已验证：两工具均注册进 TOOLS 且模型可自主调用；BioNeMo 无 key 友好降级；Biomni 子进程真实运行（ReAct 日志）、超时终止与主 Agent 降级接管（run_command 完成任务）；全量回归 22/22。
- ⏸ 待验证：BioNeMo **真实 NIM 调用**（需注册 build.nvidia.com 获取 `NVIDIA_API_KEY`，占位模式）；Biomni 任务级收敛（免费 glm-4.5-flash 对其提示格式遵循不足，需更强模型/充值）。

## [0.2.0] - 2026-10-09 —— 功能验证版（v0.2.0-verified）

在 `test/feature-verification` 分支完成六项新功能开发与全量功能验证（E2E 22/22 通过，真实 API）。

### 新增

- **计划模式**：输入区「规划模式」开关；规划回合不下发任何工具（模型无法执行），输出结构化计划卡片（目标/步骤/风险），点击「按此计划执行」后才真正运行。
- **图片上传**：📎 按钮，支持 PNG / JPG / WEBP，多选 ≤4 张、单张 ≤5MB；多模态消息接入视觉模型（`glm-4v-flash` 免费）；非视觉模型发送图片时给出明确切换提示；历史仅保留最近 3 条消息的图片。
- **文档上传与解析**：PDF（pypdf 提取文本层，默认前 30 页；扫描件无文本层时明确提示不支持 OCR）、Excel（openpyxl 多 sheet 转 Markdown，公式取计算值、合并单元格仅左上有值；`.xls` 提示转存 `.xlsx`）、FASTA（原生解析 `>` 注释行，输出序列数/长度/GC 统计）、CSV/TXT/MD/JSON。提取文本注入上下文，原始文件存 `workspace/uploads/` 供 agent 用 `read_file` 深入处理。
- **联网查询**：`web_search` 工具（DuckDuckGo → Bing 双引擎自动降级，单引擎 10s 超时，403/429 限流识别，全失败返回带原因的友好错误）；结果含引擎名与时间戳；前端渲染为可点击溯源链接。
- **需求澄清选项**：需求模糊时模型输出 ```options 结构化卡片（2-4 个互斥选项，支持单选/多选/自定义输入），点击即发送选择；历史回放为只读卡片。
- **超长对话截断**：超过 40 条消息自动截断中段（保留首条 user + 最近 N 条 + 截断标记），截断点避开 tool 消息。
- **E2E 测试套件**：`tests/e2e.mjs`（22 用例）+ `tests/fixtures_gen.py`（图片/PDF/扫描件/XLSX/FASTA 夹具）。

### 修复

- `fix(image)`：`glm-4v-flash` 的 `max_tokens` 上限为 1024，原固定 8192 导致视觉对话全部 400 失败；改为按模型映射。
- `fix(files)`：文档解析结果补充结构化元数据（`pages`/`hasText`/`sheetCount`/`count`）。
- `fix(clarify)`：模型提问回合并行调用工具（"边问边做"）——服务端硬约束：含 options 块的回合忽略 tool_calls；选项数量稳定为 2-4 个。

## [0.1.0] - 2026-10-08

初始版本。

- GLM 网页版风格前端：多会话侧边栏、Markdown 渲染、代码高亮、思考链折叠卡片（含用时）、命令/工具卡片
- 零依赖 Node 后端：GLM 开放平台 OpenAI 兼容接口（`glm-5.3` 等）、SSE 全链路流式
- Agent 工具循环：`run_command` / `read_file` / `write_file` / `list_dir`（工作区沙箱、路径越界保护）
- 会话持久化、模型切换、停止生成、复制回答
