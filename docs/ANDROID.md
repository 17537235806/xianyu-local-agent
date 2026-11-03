# Android 说明

> 结论先说：**本仓库不提供 APK**。历史版本打包过 arm64 APK（约 1.05 GB），但壳工程源码没有随本次开源一起提供；这里记录当时的做法和现在自己复刻的思路。

## 1. 历史 Android 版是什么

早期为了让「本地小咸鱼」真的能在手机上离线跑，做过一个 Android 安装包：

| 项目 | 当时的情况 |
| --- | --- |
| 架构 | 只出 `arm64-v8a`（64 位 ARM） |
| 外壳 | 一个 WebView 壳，加载打包进 `assets` 的前端页面（等价于本仓库的 `index.html` + `css/` + `js/`） |
| 推理 | 编译好的 llama.cpp JNI 动态库（`.so`），在 App 进程内直接加载模型推理 |
| 模型 | `model.gguf`（Qwen2.5-1.5B-Instruct Q4_K_M）直接打进安装包 |
| 体积 | 安装包约 **1.05 GB**（模型占绝大部分） |
| 联网 | 不需要，断网可用；聊天记录只在 WebView 的 localStorage |

后来没有继续维护、也没有随本次开源提供壳工程源码，原因很实际：

- 包体太大（1 GB 以上），应用商店、APK 分发和朋友之间传文件都很别扭；
- llama.cpp 的 JNI 编译链跟 NDK / 机型 ABI 绑得很死，别人拿到也很难复现；
- 维护成本高：模型一换、llama.cpp 一升级就要重编。

所以本仓库收敛到「可复用前端 + 本地 Python 推理服务」这一套更通用的方案。Android 端要跑，可以按下面的思路自行复刻。

## 2. 自行复刻 APK 的路线（简述）

### 2.1 方案 A：WebView + 进程内 llama.cpp（还原历史做法）

1. **准备前端**：把 `index.html`、`css/`、`js/`、`sw.js`、`manifest.webmanifest`、图标原样放进 Android 工程的 `app/src/main/assets/web/`。注意页面里的 `/api/...`、`/manifest.webmanifest` 都是绝对路径，直接 `file://` 加载会失效，下面的第 3 步会用本地 HTTP 服务解决。
2. **编译 llama.cpp**：用 NDK 交叉编译 `arm64-v8a`，得到 `libllama.so` / `libggml*.so`，或直接用社区维护的 llama.cpp Android 构建脚本；再用 JNI 写一层薄封装（加载模型、设置 `n_ctx`、按 token 回调）。
3. **起一个本机 HTTP 服务**：WebView 里 `fetch('/api/chat')` 需要一个真实 origin。常见做法是在 App 内用 `NanoHTTPD` 之类起一个只监听 `127.0.0.1` 的迷你服务，把静态资源与 `/api/health`、`/api/system`、`/api/chat`（SSE）都实现掉，然后 `WebView.loadUrl("http://127.0.0.1:<port>/")`。协议照抄 [ARCHITECTURE.md](ARCHITECTURE.md) 第 4 节即可。
   - 备选：用 `WebViewAssetLoader` 提供 `https://appassets.androidplatform.net/` 作为 origin（需要把前端里的绝对路径改成相对路径），再用 `@JavascriptInterface` 桥接推理；但那样就得不到 SSE，得自己模拟「一段一段吐字」。
4. **放模型**：`model.gguf` 打进 `assets`（会被压缩，首次启动复制到 `filesDir` 后从磁盘加载），或首次启动时让用户自选本地文件。**千万不要**在 UI 线程读模型。
5. **适配**：WebView 需开启 `javaScriptEnabled`、`domStorageEnabled`，关掉不必要的混合内容限制；加返回键处理（返回键关闭游戏面板而不是退出 App）。

### 2.2 方案 B：WebView + 外部/内置 llama-server 进程

不在 App 进程里推理，而是把 llama.cpp 的 `llama-server` 二进制打进 APK 的 `lib/` 或 `assets/`，App 启动时 `Runtime.exec()` 拉起来，监听 `127.0.0.1`，WebView 直接加载它提供的页面。

- 好处：推理与 UI 解耦，换模型、换参数都方便；`llama-server` 自带 OpenAI 兼容接口，只需写一层薄薄的 `/api/chat` SSE 适配（或改前端）。
- 坏处：要处理进程生命周期（前台服务 / 电池优化白名单）、热、内存；`exec` 可执行文件在部分 Android 版本上受限（需放在 `nativeLibraryDir` 或 `filesDir` 并给执行权限）。

### 2.3 方案 C：根本不打包 APK（推荐）

在手机上装一个 Linux 环境（Ubuntu/proot、Termux 等），把本仓库克隆下来，按 README 的「快速开始」跑 `python3 server/server.py`，再用手机浏览器打开 `http://127.0.0.1:8000`，然后「添加到主屏幕」——PWA 会以独立窗口运行，体验接近 App，且不用编 NDK。

这正是本仓库当前推荐的手机端用法：`manifest.webmanifest` + `sw.js` 已经把它做成可安装的 PWA。

## 3. 打包时容易踩的坑

- **ABI**：只出 `arm64-v8a` 能显著减小体积；x86_64 模拟器需要另编一份，或干脆不提供。
- **内存**：1.5B Q4_K_M 模型加载后常驻内存通常上 GB 级别，低内存机型会被系统杀掉；建议做「加载失败/被杀」的友好提示，并提供更小模型（如 Q2_K、0.5B）的选项。
- **包体**：APK 单包上限、Play 商店的 150 MB 基础包限制都要求用 `asset packs` / 分包；侧载分发则没这个限制，但要提醒用户留足存储。
- **模型不许进 Git**：`models/`、`*.gguf` 已在 `.gitignore` 里排除，APK 产物也不该提交。
- **许可合规**：代码 MIT（见 [LICENSE](../LICENSE)），Qwen2.5 权重是 Apache-2.0。APK 里再分发模型时，请附上 Apache-2.0 许可全文和原作者的版权声明，别把模型说成自己的。
- **省电**：常驻后台推理会明显发热耗电，务必配合前台服务与用户可见的开关。

## 4. 现状小结

| 能力 | 本仓库是否包含 |
| --- | --- |
| 可复用前端（聊天 / 五子棋 / 2048 / PWA） | ✅ |
| 本地推理服务 `server/server.py` | ✅ |
| 模型下载脚本 | ✅ |
| Android 壳工程（Java/Kotlin + JNI） | ❌ 本仓库未包含 |
| 预编译 APK / 预编译 `.so` | ❌ 未提供 |
| 模型文件 | ❌ 不进仓库，需自行下载 |

如果以后补上壳工程，欢迎把它放回仓库；在那之前，方案 C（手机 Linux + 浏览器 PWA）是最省事的路。
