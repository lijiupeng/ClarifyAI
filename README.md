# ClarifyAI

**简体中文** | [English](README.en.md)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![MCP](https://img.shields.io/badge/MCP-compatible-6f42c1.svg)

> **在 AI 动手写代码之前，先让它把需求问清楚。**

ClarifyAI 是一个给 AI 编码助手用的**需求澄清工具**。它把「AI 对需求的隐式假设」
变成一张可视化思维导图上**可逐条删改、可裁决**的显式条目 ——
在烧掉 token 和返工之前，先把分歧摊开。

---

## 它解决什么问题

用户口述需求时，通常只说得清主干三五条，剩下的细节由 AI 补全。而 AI 补的往往不是你要的：

- 它**不会告诉你**哪几条是它猜的
- 猜错了，你要么在代码里发现，要么在返工里发现
- 来回几轮，token 烧掉了，需求却还是模糊的

ClarifyAI 把这件事变成一个**有终点的流程**：

```
你的一句总需求
      │
      ▼
AI 拆成 1/2/3 条 ──────────────► 画布上逐条展示
      │                                │
不确定的标成「AI 假设」          你删改 / 裁决 / 补充
      │                                │
      └────── AI 收到你的裁决 ◄────────┘
                    │
                    ▼
        按实现路径继续拆下一层 …… 循环
                    │
                    ▼
      结构化需求规格（JSON + Markdown）→ 回灌给 AI
```

---

## 核心设计

### 1. 「AI 假设」是一等公民

AI 的每一条推断都必须显式落成 `assumption` 类型的条目，在画布上以琥珀色高亮，
**专门等你裁决**。

这是本工具存在的唯一理由：**不让 AI 的猜测混进实现里**。
其他同类工具只给你需求条目，不告诉你哪些是猜的 —— 那等于把问题藏得更深。

### 2. 验收标准强制 WHEN/THEN

每条需求都要带 `WHEN <前置条件> THEN <可观测结果>` 格式的验收标准，
且会被软校验检查格式。

**写不出验收标准，说明这条需求还没拆到位，或者本身就是模糊的。**

### 3. round 游标 —— 你的每一次操作都不会丢

MCP 宿主对工具调用有**硬超时**（不同客户端默认值不同，接入时按「接入你的 AI 助手」一节把它放大即可），
服务重启还会清空内存状态。
ClarifyAI 用「轮次游标 + 落盘数据」兜底：

- `clarify_await` 超时返回 `pending`，下次调用能**补回**期间发生的所有操作
- 服务重启后，能从磁盘把那次用户反馈**重新算出来**，不让一次真实提交石沉大海

### 4. 连线只读，结构不会被改乱

需求树与依赖关系全部由系统绘制，用户**拖不出任何连线**（`allowNode`/`allowBlank`/`allowEdge`/`allowPort` 全关）。

### 5. 可视化画布，但不需要写插件

画布是 Vue 3 + AntV X6 的横向思维导图，卡片式节点。打开方式由 AI 助手决定 ——
**用编辑器自带的内嵌浏览器即可**（VS Code / Cursor 的 `workbench.action.openSimpleBrowser`，JetBrains 的内置预览面板），
不需要开发任何原生插件。

---

## 快速开始

### 环境要求

- Node.js **>= 20**

### 从 GitHub Releases 安装（推荐）

到 [Releases](https://github.com/lijiupeng/ClarifyAI/releases) 下载 `clarifyai-x.y.z.tgz`，然后：

```bash
npm install -g ./clarifyai-0.1.4.tgz   # 全局安装
clarifyai --mode=http                  # 启动
```

打开 **http://127.0.0.1:4317** 即可。**包内已包含前端产物**，不需要再单独构建或启动 Vite。

> 不想全局安装的话：`npm install ./clarifyai-0.1.4.tgz && npx clarifyai --mode=http`

### 从源码运行

```bash
git clone https://github.com/lijiupeng/ClarifyAI.git
cd ClarifyAI
npm install
npm run build

# 单进程启动：画布 + MCP over HTTP 同一个端口
node packages/server/dist/index.js --mode=http
```

然后打开 **http://127.0.0.1:4317** —— 画布已经由服务端托管，不需要额外启动前端。

### 接入你的 AI 助手

**方式一：MCP over HTTP（推荐）**

服务常驻，画布可用性不依赖助手是否在运行，两者共享同一份会话数据。

```json
{
  "mcpServers": {
    "clarifyai": {
      "type": "http",
      "url": "http://127.0.0.1:4317/mcp",
      "timeout": 900000
    }
  }
}
```

**方式二：stdio（助手自动拉起进程）**

```json
{
  "mcpServers": {
    "clarifyai": {
      "command": "node",
      "args": ["/absolute/path/to/ClarifyAI/packages/server/dist/index.js", "--mode=both"],
      "timeout": 900000
    }
  }
}
```

> `timeout` 是**宿主对单次工具调用的硬超时**。`clarify_await` 是阻塞式的、默认单次最长等 10 分钟，
> 而不少客户端对工具调用只给 60 秒，所以这里显式放大到 15 分钟（各家字段名与单位不一，给个足够大的值即可）。
> 反过来，宿主的超时若比服务端更小，就用 `clarify_await` 的 `timeoutMs` 或服务端 `--max-block-ms` 压到上限以内。
> 就算被掐断也不丢操作：`clarify_await` 超时返回 `pending`，凭 round 游标再调一次即可。

---

## 工作原理

```
┌───────────────┐                        ┌──────────────────────┐
│   AI 助手      │◄─────── MCP ──────────►│                      │
│  (Claude Code │    stdio / HTTP        │      ClarifyAI       │
│   Cursor ...) │                        │       单进程          │
└───────────────┘                        │                      │
                                         │  · 会话状态机         │
┌───────────────┐                        │  · 反馈队列（轮次游标）│
│     你        │◄─── HTTP + WebSocket ─►│  · JSON 落盘          │
│  (浏览器画布)  │                        │  · 前端静态托管        │
└───────────────┘                        └──────────────────────┘
```

服务端**同时**提供三条通道，且共享同一个 `SessionService`：

| 通道 | 用途 |
|---|---|
| MCP stdio | 由助手进程拉起 |
| MCP over HTTP | 常驻服务，助手按 URL 连接 |
| HTTP + WebSocket | 浏览器画布，实时同步 |

**为什么这样设计**：主 Agent 通过 MCP 提交新拆解时，画布必须立刻刷新；
用户在画布上编辑时，服务端要唤醒阻塞中的主 Agent。纯 HTTP 轮询做不到这一点。

---

## MCP 工具

按需分档加载，避免工具描述本身挤占上下文（用环境变量 `CLARIFY_TOOLS` 切换）。

| 档位 | 工具数 | 说明 |
|---|---|---|
| `core` | 4 | 最小闭环 |
| `standard`（默认） | 6 | 完整流程 |
| `all` | 8 | 含诊断工具 |

| 工具 | 作用 |
|---|---|
| `clarify_start` | 上报项目上下文 + 第一层拆解，开启会话 |
| `clarify_await` | 阻塞等待用户裁决（**循环调用直到收口**） |
| `clarify_submit_decomposition` | 提交下一层拆解 / 回应批注 |
| `clarify_get_session` | 非阻塞读取当前状态 |
| `clarify_finalize` | 收口并产出需求规格 |
| `clarify_abort` | 终止会话 |
| `clarify_validate` | 需求质量体检（含 AI 纠偏率统计） |
| `clarify_list_sessions` | 找回历史会话 |

---

## 配置

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--mode` | `CLARIFY_MODE` | `both` | `mcp` / `http` / `both` |
| `--port` | `CLARIFY_PORT` | `4317` | HTTP 端口 |
| `--host` | `CLARIFY_HOST` | `127.0.0.1` | 监听地址 |
| `--data-dir` | `CLARIFY_DATA_DIR` | `~/.clarifyai/sessions` | 会话数据目录 |
| `--web-dist` | `CLARIFY_WEB_DIST` | 自动探测 | 前端产物目录 |
| — | `CLARIFY_TOOLS` | `standard` | 工具档位 |

> 默认只监听回环地址且**没有鉴权**。若要 `--host=0.0.0.0` 提供给其他机器使用，
> 请先自行加上访问控制 —— 不要把裸服务暴露到网络上。

---

## Skill —— 让助手知道「何时该用」

MCP 工具解决的是「怎么调」，**skill 解决的是「什么时候该想到调」**。

没有 skill，助手不会在你甩出一个模糊需求时主动想到「我该先把需求澄清一下」。

仓库内提供了 [`skills/clarify-requirements/SKILL.md`](skills/clarify-requirements/SKILL.md)，
覆盖：触发时机、编辑器内嵌浏览器打开、轮询阻塞等待、服务启停、
以及常见误区（比如把「待确认」当成「已确认」）。

按你所用工具的 skill 加载机制配置即可。

---

## 数据

会话以**纯 JSON** 落盘在 `~/.clarifyai/sessions/<sessionId>.json`：

- 零数据库依赖、跨平台无需编译
- 数据透明，可以直接打开查看、diff、丢进版本库

每个文件包含完整的会话状态：原始需求、项目上下文、需求树、基线快照、轮次游标。

---

## 开发

```bash
npm install
npm run dev                    # 同时启动后端(4317)与前端 Vite(5173)

npm run smoke -w clarifyai    # 端到端冒烟测试（24 项断言）
npm run typecheck                    # 类型检查
npm run build                        # 构建全部产物
```

### 项目结构

```
packages/
├── shared/     数据契约唯一真源（zod schema → 类型 → MCP 工具 I/O）
├── server/     单进程：会话状态机 + 反馈队列 + MCP + HTTP/WS
└── web/        Vue 3 + AntV X6 画布
skills/         AI 助手用的 skill
```

**设计约定**：`packages/shared` 是唯一的契约来源，服务端校验、前端类型、MCP 工具
的 `inputSchema` 全部从它派生，不重复定义。

---

## License

[MIT](LICENSE)
