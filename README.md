# 小咸鱼 · 本地智能体游戏

> A tiny, local-first chat app that runs Qwen2.5-1.5B-Instruct on your own machine, with two AI-companion mini games (Gomoku & 2048). No cloud, no accounts, no build step.

> ## ⚠️ 实验性项目：本项目为个人娱乐用途的实验性项目，功能与稳定性不作保证，请勿用于生产环境。

小咸鱼是一个跑在**本机**的聊天小应用：浏览器打开页面，背后是本地启动的 Python 推理服务（llama-cpp-python 加载 Qwen2.5-1.5B-Instruct 的 GGUF 量化模型）。断网也能聊，聊天记录只存在你自己的浏览器里。除了聊天，还有一盘「AI 陪玩」的五子棋和一个会跟你贫两句的 2048。

- 前端：纯静态 HTML/CSS/JS，无框架、无构建步骤
- 后端：单个 Python 文件（标准库 `http.server` + `llama-cpp-python`）
- 模型：Qwen2.5-1.5B-Instruct，GGUF Q4_K_M，约 1.1 GB
- 数据：全部在浏览器 `localStorage`，不上传任何地方

## 功能

| 模块 | 说明 |
| --- | --- |
| 聊天 | SSE 流式输出；可编辑人设 / 系统提示词；温度、单次最大 token 可调；对话历史本地保存；复读检测（模型绕圈时自动打断）；单轮模式避免长上下文压崩 1.5B 模型 |
| 五子棋 | 15×15 canvas 棋盘；对手是**本地规则 AI**（不是大模型），会看盘说话；可以在聊天框里说「帮我」让 AI 给建议甚至替你落子 |
| 2048 | 方向键 / 滑动手势；悔棋 3 次；本地最高分与排行榜；同样会看局面说话 |
| PWA | 可「添加到主屏幕」；Service Worker 缓存应用外壳；离线可用（聊天仍需本机 `/api` 在跑） |

## 快速开始

前置条件：Python 3.9+，能跑 llama.cpp 的机器（约 1.1 GB 模型 + 运行时内存），以及能联网下载一次模型。

```bash
# 1. 安装 Python 依赖
pip install -r server/requirements.txt

# 2. 下载模型（约 1.1 GB，存到 models/ 下，不进 Git）
bash server/download-model.sh

# 3. 启动本地服务（默认 http://127.0.0.1:8000）
python3 server/server.py

# 4. 浏览器打开
#    http://127.0.0.1:8000
```

页面右上角圆点变绿、显示「已连接本地模型」就说明服务通了；红点表示模型没加载好或服务没起来。

> **注意**：本仓库只提供 `server/server.py` 这一套 `/api` 协议实现。如果你用别的 llama.cpp 兼容服务（如 `llama-server`、Ollama 的兼容层），需要自己适配 `/api/health`、`/api/system`、`/api/chat` 三个接口，前端不会直接可用。

## 目录结构

```
xianyu-local-agent/
├── index.html              # 单页外壳：聊天 / 设置 / 五子棋 / 2048
├── css/style.css           # 全部样式
├── js/app.js               # 全部前端逻辑（单文件，按模块用 IIFE 分区）
├── sw.js                   # Service Worker：只缓存外壳，/api 一律直连
├── manifest.webmanifest    # PWA 清单
├── avatar.png              # 头像
├── icon-192.png            # 图标
├── icon-512.png            # 图标
├── icon-maskable-512.png   # Android 自适应图标
├── apple-touch-icon.png    # iOS 主屏图标
├── server/                 # 本地推理服务（Python）
│   ├── server.py           # 静态文件 + /api 路由 + SSE
│   ├── requirements.txt    # Python 依赖
│   ├── download-model.sh   # 模型下载脚本
│   ├── test_api.py         # 不依赖真模型的接口测试
│   └── README.md           # 服务端使用说明
├── docs/
│   ├── ARCHITECTURE.md     # 架构、数据流、协议、存储、缓存、游戏实现
│   └── ANDROID.md          # 历史 APK 说明与自行打包思路
├── .github/workflows/ci.yml
├── LICENSE                 # MIT
└── README.md
```

`models/`（模型文件）和 `server.log` 已在 `.gitignore` 中排除，不会进仓库。

## 接口协议

前端只依赖三个接口，全部由 `server/server.py` 提供：

| 方法 | 路径 | 作用 | 返回 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | 健康检查（前端每 8 秒轮询一次） | JSON，`{"ok": true}` 表示模型已就绪 |
| `GET` | `/api/system` | 查询运行信息 | JSON，含上下文长度 `n_ctx`（兼容 `context` / `contextSize` 字段名） |
| `POST` | `/api/chat` | 流式对话 | `text/event-stream`，逐行 `data: {"t":"..."}`，结束发 `data: [DONE]` |
| `GET` | `/` 及静态资源 | 页面壳 | `index.html`、`css/`、`js/`、图标等 |

`POST /api/chat` 请求体示例：

```json
{
  "system": "你是「小咸鱼」，一条扁扁的、软趴趴的小鱼干……",
  "messages": [{ "role": "user", "content": "今天好累啊" }],
  "temperature": 0.6,
  "max_tokens": 768
}
```

流式响应示例：

```
data: {"t":"那就"}
data: {"t":"先躺五分钟吧。"}
data: [DONE]
```

出错时返回非 2xx 的 JSON，形如 `{"error": "..."}`，前端会把错误原文显示在对话里。

## 模型与许可

- **模型**：[Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) 由阿里通义千问团队开源，权重许可为 **Apache-2.0**。
- **量化**：仓库脚本下载 HuggingFace 上 [bartowski](https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF) 的 `Q4_K_M` GGUF 版本（约 1.1 GB）。想自己转也可以用 llama.cpp 工具链（`convert_hf_to_gguf.py` + `llama-quantize`）。
- **代码**：本仓库代码以 **MIT** 许可发布，全文见 [LICENSE](LICENSE)。
- **模型文件**：不进仓库（`.gitignore` 已排除 `models/`、`*.gguf`）。分发或再发布模型权重时请遵守 Apache-2.0 并保留原作者的版权与许可声明。

## 常见问题（FAQ）

**Q：模型能换吗？**
能。任何 llama.cpp 能加载的 `.gguf` 都行，把 `server/server.py`（或下载脚本）指向的模型路径改掉、或用 `--model` 参数指定即可，例如换成 Qwen2.5-3B / 7B 的 GGUF。模型越大越吃内存，1.5B 是为手机端收敛过的选择。

**Q：为什么仓库里没有 APK？**
历史 Android 版确实打包过 arm64 APK（详情见 [docs/ANDROID.md](docs/ANDROID.md)），但包体约 1.05 GB，且壳工程源码没有随本次开源一起提供。所以仓库只包含可复用的前端和本地推理服务方案；想复刻 APK 可以按 ANDROID.md 里的思路自己拼。

**Q：手机能跑吗？**
能，但有门槛：需要 **arm64**（`arm64-v8a`）设备，并且给模型和运行时留够内存（1.5B Q4_K_M 建议至少 2–3 GB 可用内存，实际取决于系统占用）。在 Android 上可以装在 Ubuntu/proot 之类的环境里跑 `server.py`，也可以用 Termux 编译 llama.cpp。低端机可能几秒才出一个字，属正常现象。

**Q：数据会上传吗？**
不会。前端只请求本机 `127.0.0.1:8000`，聊天记录、设置、2048 排行榜全在浏览器 `localStorage`。换浏览器或清缓存就没了。

**Q：为什么不把历史对话都发给模型？**
1.5B 模型上下文很小，历史一长就容易胡言乱语甚至崩掉。所以默认是**单轮模式**：只发当前这一句 + 系统提示词。历史仍会保存在本地供你回看。

**Q：回答绕圈、复读怎么办？**
前端有复读检测：尾部连续重复片段 ≥4 次，或同一句在最近 16 句里出现 3 次，就自动截断并提示。再不济点发送键变成的「■」手动中止。

**Q：为什么是「小咸鱼」，还有个「白饭团」？**
人设就是一条爱躺平的鱼干，「白饭团」是它那位圆滚滚、爱吃白饭的朋友。人设文本在设置里可以随便改。

## 开发与测试

没有构建步骤，改完刷新页面即可（Service Worker 缓存外壳，必要时在 DevTools 里更新/注销 SW）。

```bash
# JS 语法检查
node --check js/app.js

# Python 语法检查
python3 -m py_compile server/server.py
```

仓库自带一个轻量 CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）：push / PR 时跑上面的语法检查，并确认 `index.html` 等入口文件存在。

## 致谢

- [Qwen2.5](https://github.com/QwenLM/Qwen2.5) —— 模型与权重
- [llama.cpp](https://github.com/ggerganov/llama.cpp) / [llama-cpp-python](https://github.com/abetlen/llama-cpp-python) —— 本地推理
- [bartowski](https://huggingface.co/bartowski) —— GGUF 量化
- 以及所有在小手机上折腾本地模型的人

---

实验性项目，欢迎提 issue 或 PR，但请别指望它稳定。代码 MIT，模型 Apache-2.0，玩得开心。
