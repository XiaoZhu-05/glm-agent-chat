# 调研报告：BioNeMo 与 Biomni 集成可行性（Agent 侧、零部署）

> **调研日期**： 2026-10-09
> **调研对象**： NVIDIA BioNeMo / Stanford Biomni
> **目标**： 评估两者能否集成到现有 glm-agent-chat Agent，**硬性约束：不部署服务器、不做后端运维，只做 Agent 侧集成**
> **方法**： 全部结论真实联网核实（官方文档 / GitHub / PyPI）+ 本机实测（独立 venv 试装、最小示例运行）
> **约束遵守**： 未部署任何服务、未下载大数据（Biomni 11GB 数据湖实测跳过）、未产生任何费用

---

## 一、工具 A：BioNeMo（NVIDIA）调研结论

**性质**： NVIDIA 的生物大模型**框架与模型集合**（结构预测 / 分子生成），本身不是 agent，是"被调用者"。

### 1. 可获得性

| 渠道 | 地址 | 状态 |
|---|---|---|
| GitHub（官方组织） | https://github.com/NVIDIA-BioNeMo | framework / inference-runtime / recipes 三仓库 |
| PyPI | https://pypi.org/project/bionemo-core/ | 最新 **2.4.5（2025-08-19）**，`requires-python >=3.10`（本机 3.12 ✓），依赖 `torch>=2.2.1`、`ngcsdk` 等；以**子包**发布，无 `bionemo-framework` 主包 |
| HuggingFace | —（模型权重走 NGC 渠道） | 非主分发渠道 |
| NIM 托管 API | https://build.nvidia.com/explore/biology | 含 ESMFold、OpenFold3 等云端端点 |

### 2. 许可证

- **代码： Apache-2.0**（官方 FAQ 确认：https://docs.nvidia.com/bionemo-framework/latest/main/references/FAQ）
- ⚠️ **模型权重： NVIDIA Open Model License**（商用条款另行约束）
- 数据： CC BY 4.0

### 3. 集成方式（重点）

| 方式 | 状态 | 说明 |
|---|---|---|
| REST API（NIM 云端） | ✅ 官方，**推荐** | `POST https://health.api.nvidia.com/v1/biology/nvidia/esmfold`，`Authorization: Bearer $NVIDIA_API_KEY`，body `{"sequence":"氨基酸序列"}`（≤1024 aa，**非 FASTA**），返回 **PDB 文本**。纯 `requests` 可调，零 SDK |
| Python SDK（本地 pip） | ⚠️ 官方但本机不可行 | 子包可装，但推理需 A100/H100 级 GPU + 多 GB 权重 |
| MCP Server | ❌ 无官方预构建 | NVIDIA 有自建 MCP wrapper 教程（https://developer.nvidia.com/blog/build-an-ai-scientist-for-life-science-discovery-with-bionemo-agent-toolkit），但需自己起服务，违背"不部署"约束 |
| OpenAI Function Calling | ❌ | 模型页明确标注 "Function Calling: Not supported"（自定义 JSON 协议） |
| `bionemo-skills` 封装 | ❌ 未发现 | **未能验证 / 大概率不存在** |

最小调用示例（≤30 行，来自官方模型页 https://build.nvidia.com/meta/esmfold）：

```python
import requests

url = "https://health.api.nvidia.com/v1/biology/nvidia/esmfold"
headers = {
    "Authorization": f"Bearer {NVIDIA_API_KEY}",
    "Accept": "application/json",
    "Content-Type": "application/json",
}
payload = {"sequence": "MDILCEENTSLSSTTNSLMQLNDDTRLYSNVFVWIGYLSSAVNPLVY"}
resp = requests.post(url, headers=headers, json=payload)
print(resp.json())  # 返回蛋白质结构 Pose（PDB 文本）
```

### 4. GPU 与本机现实（实测）

- 本机：4GB 显存 GeForce + **CUDA 11.6 老驱动**（`nvidia-smi` 实测）→ ESMFold(3B 参数) 官方需 A100/H100，**本地推理路径排除**
- CPU：官方不支持核心模型 CPU 推理（**未能验证** CPU 路径，无实测意义）
- **结论：BioNeMo 唯一符合约束的路径 = NIM 云端 REST**

### 5. 未验证项

NIM 实际调用未测试——需注册 https://build.nvidia.com 获取免费 `NVIDIA_API_KEY`（注册免费有赠送额度，具体额度**未能验证**）。

---

## 二、工具 B：Biomni（Stanford SNAP Lab）调研结论

**性质**： 本身就是一个**生物医学 LLM Agent**（ReAct + 30+ 工具域 + 检索 + 数据湖）。集成方式 = 作为我们 Agent 可调用的"重型生物医学子 agent"。

### 1. 可获得性（全部实测验证 ✅）

- GitHub： https://github.com/snap-stanford/biomni（官方）
- 网站： https://biomni.stanford.edu
- PyPI： `pip install biomni`，**v0.0.8（2025-10-27）**，wheel 仅 543KB，`requires-python >=3.11`（本机 3.12.10 ✓）
- **核心依赖仅 3 个**（pydantic / langchain / python-dotenv）——实测装入独立 venv（`E:\1_溯本源和\_research\biomni-venv`），共约 45 个纯 Python 包，**无 torch、无编译依赖**；A1 agent 需手动补装 `pandas`、`langchain_openai`、`tqdm`（README 明示工具依赖按需手装）

### 2. 许可证

- **Apache-2.0**（README 明示）
- ⚠️ bundled 数据库/工具有更严许可：运行时提示 "Academic mode: Using all datasets (including non-commercial)"（实测见到），**商用需开 commercial mode 并注意数据许可**

### 3. 集成方式（重点，含实测）

- **LLM 可配 GLM** ✅ 官方支持 Custom OpenAI 兼容端点（README + `docs/configuration.md`）：
  ```python
  agent = A1(
      path=".",
      llm="glm-4.5-flash",
      base_url="https://open.bigmodel.cn/api/paas/v4",
      api_key=GLM_KEY,
      expected_data_lake_files=[],   # 跳过 11GB 数据湖
  )
  agent.go("任务描述")
  ```
  也支持环境变量 `BIOMNI_CUSTOM_BASE_URL` / `BIOMNI_CUSTOM_API_KEY`。**实测配置生效**（日志确认 `openai_api_base=open.bigmodel.cn`）。
- **数据湖 11GB 可跳过** ✅ 实测：`expected_data_lake_files=[]` → 打印 `Skipping datalake download`。代价：依赖数据湖的工具（数据库查询类）不可用，纯代码/文献类任务不受影响
- **MCP 双向支持** ✅ 官方：`agent.add_mcp(config_path=...)` 消费外部 MCP server；仓库带把自己暴露为 MCP server 的示例（`tool/example_mcp_tools/pubmed_mcp.py`）——**官方代码示例**，非仅社区方案
- `BiomniProvider` 封装：**未发现（不存在）**

### 4. ⚠️ 实测最小示例（重要发现）

任务：GLM 驱动 Biomni 计算 DNA 序列 GC 含量（完整日志：`E:\1_溯本源和\_research\biomni-sandbox\demo_run2.log`）：

- ✅ 集成链路全通：安装 → GLM 配置 → 数据湖跳过 → ReAct 循环 → **LLM 生成代码被真实执行**
- ❌ **任务未收敛**：glm-4.5-flash 对 Biomni 的 `</execute>` 停止标签遵循不稳（连续生成畸形标签导致语法错误自纠循环），420 秒 31 轮未出结果
- **定性**：免费 flash 模型能力问题，**不是集成问题**——Biomni 论文基准使用 Claude Sonnet 级模型；换 glm-4.6 / glm-5.3（需充值）预期能收敛，**此推断未能验证**

### 5. 安全（沙箱问题）

README 官方警告：agent 会**以完整系统权限执行 LLM 生成的代码**（可访问文件 / 网络 / 命令）。集成时必须：子进程 + 独立 venv + cwd 限制在 workspace + 建议后续容器化。现有 `run_command` 的 30s 超时 / 输出截断强度不够（Biomni 单任务需数分钟）。

### 6. 能力边界

- 30+ 生物医学工具域：genomics / proteomics / literature / database（ChEMBL、ClinVar、GWAS 等 40+ schema 内置）/ immunology / cell biology 等
- 输入输出：自然语言任务 → 生成 Python 代码执行 → 文本/DataFrame 结果
- GPU：不需要（云端 LLM）
- 工具检索器：`use_tool_retriever` 可关；构造在无 OPENAI_API_KEY 下成功（实测），完整检索行为未验证

---

## 三、对比表

| 维度 | BioNeMo | Biomni |
|---|---|---|
| 可获得性 | GitHub + PyPI 子包 + NIM 云端 ✅ | GitHub + PyPI ✅（v0.0.8，2025-10） |
| 许可证 | 代码 Apache-2.0；**权重 NVIDIA Open Model License（商用受限）** | Apache-2.0；**bundled 数据非商业许可（学术模式）** |
| 集成方式 | NIM 云端 REST（官方，自定义 JSON，非 OpenAI 兼容）；无官方 MCP | Python 库调用（官方）；**官方 MCP 双向示例**；LLM 可配 GLM（实测） |
| 是否需 GPU | 云端路径不需要；本地路径需要（本机 4GB / CUDA 11.6 不满足） | 不需要（云端 LLM） |
| 是否需部署服务 | 否（NIM 托管） | 否（进程内 / 子进程调用） |
| 接入 Agent 难度 | **低**（server.js 加一个 fetch 工具，约 40 行） | **中**（venv + 子进程 + 沙箱 + 跳数据湖 + 更强 LLM） |
| 本次实测程度 | PyPI / 端点文档核实，**API 调用未测（无 key）** | **装通 + 跑通到代码执行层**，任务收敛受免费模型限制 |
| 推荐度 | ⭐⭐⭐⭐⭐（零依赖零冲突） | ⭐⭐⭐（可行但需充值模型 + 沙箱加固） |

## 四、推荐方案：优先接 BioNeMo（NIM 云端），Biomni 缓接

1. **BioNeMo 优先**：唯一同时满足"零部署、零 Python 依赖、零依赖冲突"的路径。`protein_structure` 工具只调 NIM REST，与现有计划模式 / 联网查询 / 文件阅读功能零冲突。前置条件仅一个：注册 build.nvidia.com 拿免费 API key。
2. **Biomni 缓接**：技术可行性已验证，但 (1) 需要 glm-4.6+ 级模型才有实用价值（当前 key 无余额）；(2) 全权限代码执行需先加固沙箱；(3) 30+ 工具域依赖按需安装是长期维护成本。建议作为二期。

## 五、最小可行集成方案（BioNeMo 路线）

1. **装**：无需安装任何东西（纯 REST）
2. **配置**：`.env` 加 `NVIDIA_API_KEY=nvapi-xxx`
3. **写**：`server.js` 的 `TOOLS` 数组加工具定义 + `executeTool` 加分支（`fetch('https://health.api.nvidia.com/v1/biology/nvidia/esmfold')`，输入序列，输出 PDB 存 workspace 并返回路径 + 摘要）
4. **暴露 tool**：`protein_structure(sequence)`——模型收到序列类问题自动调用；前端已有工具卡片自动展示

（Biomni 二期方案：独立 venv + `biomni_task(task)` 工具 spawn 子进程跑 A1，`expected_data_lake_files=[]`，cwd 锁定 workspace。）

## 六、风险与未决问题清单

| # | 等级 | 问题 |
|---|---|---|
| 1 | 🔴 | NIM 免费额度与后续计费未知（**未能验证**，需注册后确认）；ESMFold 输入限 1024 aa，长序列会被拒 |
| 2 | 🟡 | Biomni + glm-4.5-flash 不收敛（实测）；需充值验证 glm-4.6/5.3（**花钱操作，待用户决定**） |
| 3 | 🟡 | Biomni 全权限代码执行——集成前建议容器化（当前 workspace+子进程强度不够） |
| 4 | 🟡 | BioNeMo 权重许可限制商用（代码不受限） |
| 5 | 🟢 | Biomni v0.0.x 版本号尚早，API 可能变动 |

## 七、下一步行动项

1. **注册 NIM key** → 实施 `protein_structure` 工具（推荐先做，约半小时）
2. **Biomni 深度验证**：决定是否给 key 充值后用 glm-4.6 重跑收敛性测试（涉及花钱，不擅自执行）
3. **Biomni 沙箱加固方案**（容器 / 受限子进程）——若选二期再展开
4. 11GB 数据湖完整下载（启用数据库查询类工具）——**大下载，默认不做**

---

## 参考来源

**BioNeMo**
- GitHub 组织： https://github.com/NVIDIA-BioNeMo
- bionemo-core（PyPI）： https://pypi.org/project/bionemo-core/
- 官方 FAQ（许可证）： https://docs.nvidia.com/bionemo-framework/latest/main/references/FAQ
- ESMFold NIM 端点： https://build.nvidia.com/meta/esmfold
- Biology NIM 目录： https://build.nvidia.com/explore/biology
- BioNeMo Agent Toolkit 博客（MCP wrapper 教程）： https://developer.nvidia.com/blog/build-an-ai-scientist-for-life-science-discovery-with-bionemo-agent-toolkit
- NIM for ESMFold（NGC）： https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nim/collections/bionemo-esmfold

**Biomni**
- GitHub： https://github.com/snap-stanford/biomni
- LLM 配置文档： https://github.com/snap-stanford/Biomni/blob/main/docs/configuration.md
- 官网： https://biomni.stanford.edu
