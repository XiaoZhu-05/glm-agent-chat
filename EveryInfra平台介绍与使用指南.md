# EveryInfra 平台介绍与使用指南

> 基于 2026-10-10 的真实 API 调研与实测（目录数据来自免 key 接口实时抓取，价格为官方 catalog 标价）。
> 本项目已通过 `everyinfra_data` 工具完成接入，真实付费调用验证通过。

## 一、EveryInfra 是什么

[EveryInfra](https://everyinfra.com)（中文名「万有引擎」）是一家 **AI 数据采集基础设施**服务商，面向 Agent / 自动化场景提供四大能力：

| 产品 | 能力 | 说明 |
| --- | --- | --- |
| **EveryData** | 90 个平台的数据采集 | 小红书 / 抖音 / B站 / 知乎 / 微博 / 淘宝 / TikTok / YouTube / Reddit 等共 409 个「平台 × 动作」能力 |
| **EverySearch** | 17 种联网搜索工具 | web / news / scholar / semantic / read / crawl / crosscheck（事实核查）等 |
| **EverySolve** | 53 种验证码识别 | 配合采集场景使用 |
| **AI API** | OpenAI 兼容接口 | 充值后 AI 调用免费（本项目用 GLM，未使用该能力） |

官方定位声明：**只提供工具与服务，不拥有、不转售、不再分发底层数据**——它是数据访问的自动化层，数据权利归各平台与发布者。使用时请遵守目标平台条款，数据用于研究与分析。

### 核心机制

- **计价**：预充值 credits 制。1 元 = 10000 credits。搜索 ¥0.005/次（50 credits），采集按平台定价 ¥0.0037~0.037/次，事实核查 crosscheck ¥0.02/次。响应里带 `billing`（本次扣费）与 `quota`（余额）回执。
- **同步 / 异步**：默认同步等待（官方同步窗口约 100 秒）；请求体加 `"mode":"async"` 立即返回 `job_id`（202），之后轮询 `GET /api/v1/jobs/{job_id}` 取结果。慢任务（如小红书热榜实测 41 秒）适合异步。
- **免 key 目录**：`GET /api/v1/social/catalog[?platform=]` 与 `GET /api/v1/search/tools` 无需鉴权，可随时查支持的平台、动作、参数与价格——**写代码/提问前先查目录，不要猜参数名**。
- **翻页**：响应含 `next_page_token` 时，下次请求把 `page_token` 传入即可取下一页。
- **Agent 友好**：官方提供 [agents.md](https://everyinfra.com/agents.md)、llms.txt 与 MCP 端点（`https://api.everyinfra.com/mcp`）。

## 二、数据采集能力总览（EveryData，90 平台 / 409 能力）

### 2.1 重点平台明细（价格为实测时官方标价，元/次）

#### 小红书 xiaohongshu（10 个动作，¥0.037/次）
| 动作 | 必填参数 | 可选参数 |
| --- | --- | --- |
| search 关键词搜索 | keyword | content_type / date_range / sort |
| search_users 用户搜索 | keyword | follower_range / user_type |
| note 笔记详情 | url | — |
| comments 笔记评论 | url | sort |
| comments_batch 批量评论 | urls | sort |
| sub_comments 评论回复 | url + comment_id | — |
| profile / user_posts 用户主页与内容 | user_id | — |
| hashtag 话题内容 | topic_id | sort |
| trending 热榜 | （无需参数） | — |

#### 抖音 douyin（18 个动作，¥0.004/次——比小红书便宜 10 倍）
除常规 search / video / comments / trending / transcript（视频文稿）外，还有一整套**达人经营分析**：
- creator_search（达人搜索）/ creator_audience（粉丝画像）/ creator_trend（涨粉趋势）/ creator_benchmark（同类对标）
- **星图三件套**：xingtu_creator_search / xingtu_creator_analytics / xingtu_rate_card（达人报价）/ xingtu_creator_rankings（行业达人榜）
- 电商：product_search / product_detail / live_product_search（直播商品）

#### B站 bilibili（7 个动作，¥0.004/次）
search / video / comments / **danmaku（弹幕）** / **subtitles（字幕）** / profile / user_posts

#### 知乎 zhihu（6 个）、微博 weibo（4 个）、微信公众号 wechat_oa（12 个）
知乎：search / content_detail / content_comments / comment_replies / profile / user_articles。
微博：search / profile / comments / trending（热榜）。公众号 wechat_oa 是覆盖动作最多的平台之一（12 个）。

#### 电商（taobao ¥0.009 / jd ¥0.009 / xianyu ¥0.037 / alibaba1688 / dewu 得物）
淘宝：search（支持 min_price/max_price/sort/tmall_only）/ product_detail / shop / **reviews（评价）** / **questions（问大家）**。
京东：search / product_detail / reviews / shop / product_price（价格监控）。

#### 海外平台（大多 ¥0.004/次）
- **TikTok**（10 动作）：search / comments / transcript / hashtag / shop_search（TikTok Shop）/ shop_creator（带货达人）
- **YouTube**（8 动作）：search / video / comments / **transcript（文稿）** / shorts / followers / user_posts
- **Twitter/X**（8 动作）、**Instagram**（11 动作）、**Facebook**（10 动作）、**Reddit**（5 动作：subreddit_posts / post_detail / comments / user_posts）
- **Telegram / Discord / Threads / Pinterest / Quora / Medium / Substack / Patreon** 等

### 2.2 其余平台按场景分类（动作数）

| 场景 | 平台（动作数） |
| --- | --- |
| 海外电商/比价 | amazon(5) temu(2) shopee(4) aliexpress(6) ebay(4) etsy(5) walmart(4) |
| 招聘/职场 | linkedin(8) indeed(5) glassdoor(6) upwork(2) xing(4) naukri(2) seek(1) stepstone(1) dice(1) |
| 本地生活/旅行 | google_maps_reviews(3) yelp(3) tripadvisor(5) airbnb(5) booking(4) expedia(4) |
| 房产 | zillow(5) realtor(3) crexi(2) craigslist(1) |
| 软件与商业评论 | g2(7) capterra(2) trustpilot(2) clutch(3) similarweb(3 流量分析) |
| 财经 | yahoo_finance(7) |
| 视频/音乐/创意 | twitch(6) spotify(7) soundcloud(6) rumble(6) odysee(4) dailymotion(6) flickr(2) deviantart(4) behance(2) dribbble(3) |
| 社区/长文 | reddit(5) quora(6) medium(3) substack(7) patreon(4) producthunt(4) mastodon(5) bluesky(5) lemmy(4) gab(4) truth_social(5) vk(2) tumblr(4) |
| 应用商店 | google_play(3) app_store(3) |
| 国内长视频/音乐 | youku(4) iqiyi(3) netease_music(3) toutiao(4) douban(4 豆瓣书影评论) |

> 完整实时目录：让 agent 调 `everyinfra_data kind=catalog`（全量）或 `kind=catalog platform=<平台名>`（单平台动作与参数）。

## 三、17 种搜索工具（EverySearch，¥0.005/次，crosscheck ¥0.02）

| 工具（必填参数） | 用途 |
| --- | --- |
| web(q) | 通用网页搜索，可选 site 站内限定 / location 地区 / after·before 时间窗 / page 翻页 / num 条数 |
| news(q) | 新闻搜索 |
| scholar(q) | 学术文献搜索；kind=patents 切换专利检索（公开号/申请人/发明人） |
| semantic(q) | 语义检索：用一句自然语言描述需求，能找到标题不含关键词的深层来源 |
| forum(q) | 真人讨论检索——官方文档说「支持」而论坛说「有坑」时，以后者为准的独立证据源 |
| deep(q) | 带正文摘要的深度搜索，full=true 连全文取回 |
| read(url) | 抓取指定 URL 正文，多级降级，一家抓不到自动换下一家 |
| crawl(url) | 爬一个站点的多个页面取正文，可用自然语言指定只要哪类页面 |
| harvest(target) | 结构化站点抓取（长任务，十几秒到几分钟），crawl 拿不到时用 |
| map(url) | 列出站点页面结构，只出 URL 不取正文，很快 |
| similar(url) | 语义找相似页面——关键词搜索做不到 |
| lens(url) | 反向图搜：给图找用了这张图的页面 |
| media(q) | 用词找图片与视频 |
| crosscheck(q) | **事实核查**：多机制并行检索并按「被几种机制同时命中」给来源分层，回答「这个结论有多可信」 |
| shopping(q) | 商品搜索与比价 |
| places(q) | 地点与商户搜索 |
| suggest(q) | 搜索联想词 |

## 四、在本项目（glm-agent-chat）中的使用

工具名 `everyinfra_data`，四种 kind：

```
kind=catalog                      # 查目录（免 key、免费）：平台列表 / 单平台动作参数价格 / 搜索工具
kind=social  platform=… action=… params={…} [mode=sync|async]   # 平台采集（付费）
kind=search  tool=… params={…}    # 搜索工具（付费）
kind=job     job_id=…             # 异步任务续查
```

行为：完整 JSON 自动落盘 `workspace/everyinfra/`；输出带预览与翻页指引；202 异步任务自动轮询（2s 间隔、上限 120s）；网络走内置 CONNECT 代理隧道（`.env` 的 `EVERYINFRA_PROXY=http://127.0.0.1:7897`）。工具描述内置付费护栏：约 ¥0.004~0.04/次，仅用户明确要求采集时调用。

配置（`.env`）：`EVERYINFRA_API_KEY`（console 创建，`ei_` 开头）、`EVERYINFRA_PROXY`（本机代理）。当前余额见控制台 Billing 页（2026-10-10 实测时 ¥6.66）。

## 五、能做什么：典型场景

1. **内容选题与热点追踪**：小红书/微博/抖音热榜 → 找趋势；话题 hashtag 内容 → 选题灵感。
2. **舆情与口碑分析**：关键词搜索 + 批量评论采集 → 用户痛点/好评差评归纳（小红书 comments_batch、淘宝 reviews/questions）。
3. **达人/博主筛选**：抖音达人搜索 + 粉丝画像 + 涨粉趋势 + 星图报价 → 投放候选表。
4. **电商选品与比价**：淘宝/京东/Temu/Amazon 搜索 + 评价 → 竞品价格带与差评点；京东 product_price 做价格监控。
5. **深度调研**：scholar 查文献、forum 找真实用户经验、read/crawl 取全文、similar 顺藤摸瓜、crosscheck 核查结论。
6. **视频内容分析**：YouTube/TikTok/B站 transcript 拿文稿 → 总结；B站 danmaku 弹幕 → 高频词/情绪。
7. **招聘与公司调研**：LinkedIn/Indeed/Glassdoor 岗位与评价、g2/capterra 软件评测、similarweb 流量。

## 六、测试问题清单（按成本分级）

> 建议用免费模型 glm-4.5-flash 测试；每次调用结果 JSON 落盘 `workspace/everyinfra/`，可追问「读上一次结果文件继续分析」。

**第 0 级：免费（目录查询）**
1. 「EveryInfra 支持哪些平台？分别能采什么？」
2. 「我想采小红书，告诉我可用动作、必填参数和价格。」

**第 1 级：搜索工具（¥0.005/次）**
3. 「用 everyinfra 的 scholar 工具搜 3 篇蛋白质结构预测（ESMFold）相关论文。」
4. 「用 news 工具搜最近智谱 GLM 的新闻，列标题和链接。」
5. 「用 forum 工具搜大家对 Node.js 单线程扩容的真实经验。」
6. 「用 read 工具读这个链接的正文并总结：<任一文章 URL>」
7. 「用 semantic 工具找讲『多智能体协作失败模式』的深度文章。」
8. 「用 crosscheck 核查一下『长期喝咖啡会导致骨质疏松』这个说法的可信度。」（¥0.02）

**第 2 级：平台采集（¥0.004~0.037/次）**
9. 「采一下微博热榜，列前 10 条。」（¥0.004，秒回）
10. 「抖音搜『露营装备』，按点赞排前 5 条视频。」（¥0.004）
11. 「B站这个视频的弹幕都说了什么？<视频 URL>，总结高频词。」（¥0.004）
12. 「知乎搜『蛋白结构预测』，总结高赞回答的要点。」（¥0.004）
13. 「淘宝搜『机械键盘』，500 元以内按销量排，列前 10 的价格和销量。」（¥0.009）
14. 「采小红书热榜前 10 条。」（¥0.037，较慢，agent 会自动走异步任务）

**第 3 级：多步组合（考验 agent 编排能力）**
15. 「小红书搜『防晒霜』，挑 3 篇互动最高的笔记，采它们的评论，总结用户最在意的 3 个痛点。」（≈4 次调用 ≈¥0.15）
16. 「对比小红书和抖音上『 XX 品牌』的内容热度差异。」（2 次采集）
17. 「先用 scholar 查『扩散模型』的论文，再用 forum 搜大家实测的使用体会，两边对照给我一个综述。」

## 七、注意事项

- **余额**：控制台 Billing 页可查；搜索类便宜（¥0.005），小红书最贵（¥0.037），测试全清单一遍约 ¥0.5。
- **慢任务**：官方同步窗口约 100s；本项目工具默认超时 120s，agent 可对慢动作用 `mode=async`。
- **网络**：api.everyinfra.com 部分网络直连不通（本项目已配本机代理走 CONNECT 隧道）。
- **合规**：EveryInfra 只是工具层，不拥有数据；采集结果用于研究分析，注意各平台用户协议、版权与隐私，不要二次分发原始数据。
- **价格变动**：以 `kind=catalog` 实时查询为准，本文档价格为 2026-10-10 标价。
