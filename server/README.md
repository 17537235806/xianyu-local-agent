# 本地推理服务（server/）

小咸鱼 · 本地版的「大脑」：一个跑在本机的 Python 小服务，用
[llama-cpp-python](https://github.com/abetlen/llama-cpp-python) 加载
Qwen2.5-1.5B-Instruct（GGUF）并流式输出，同时把工程根目录的前端
（`index.html` / `css/` / `js/` / 图片）直接 serve 出去。

- Web 层只用 Python 标准库 `http.server`，**不依赖 FastAPI / Flask**；
- 推理部分依赖 `llama-cpp-python`，模型为 Apache-2.0 的 Qwen2.5-1.5B-Instruct；
- 完全本地运行，聊天内容不离开这台机器。

---

## 目录结构

```
xianyu-local-agent/
├── index.html            # 前端（浏览器打开的就是它）
├── css/  js/  图片…       # 前端静态资源
├── models/               # GGUF 模型放这里（下载脚本会创建）
│   └── Qwen2.5-1.5B-Instruct-Q4_K_M.gguf
└── server/
    ├── server.py         # 本地推理服务（本文件）
    ├── requirements.txt  # Python 依赖
    ├── download-model.sh # 下载模型脚本
    ├── test_api.py       # 不依赖真实模型的接口测试
    └── README.md         # 就是你现在看的这份
```

---

## 快速开始

在**工程根目录**（`xianyu-local-agent/`）下执行：

```bash
# 1. 安装依赖（只需一次）
pip install -r server/requirements.txt

# 2. 下载模型（约 1 GB，只需一次）
bash server/download-model.sh

# 3. 启动服务
python3 server/server.py

# 4. 浏览器打开
#    http://127.0.0.1:8000/
```

看到类似下面的输出就说明启动成功了：

```
[2/2] 加载完成，服务已启动：
      打开   http://127.0.0.1:8000/
      接口   GET /api/health  GET /api/system  POST /api/chat
```

> 手机上用系统浏览器打开 `http://127.0.0.1:8000/` 即可；
> 同一局域网的其他设备访问，用 `--host 0.0.0.0` 启动后
> 打开 `http://<手机/电脑的局域网 IP>:8000/`。

---

## 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--model PATH` | 自动找 `models/*.gguf` | 指定 GGUF 模型文件；没写时优先挑名字里带 `Q4_K_M` 的 |
| `--host ADDR` | `127.0.0.1` | 监听地址；要局域网访问就写 `0.0.0.0` |
| `--port N` | `8000` | 监听端口 |
| `--n-ctx N` | `2048` | 上下文长度（token），越大越吃内存 |
| `--threads N` | CPU 核心数 | 推理线程数 |
| `--verbose` | 关闭 | 打印每一次请求（包括每 8 秒一次的健康检查） |

例子：

```bash
# 手机省内存的保守配置
python3 server/server.py --n-ctx 1024 --threads 2

# 局域网共享
python3 server/server.py --host 0.0.0.0 --port 8000

# 手动指定模型
python3 server/server.py --model models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf
```

---

## 接口协议

前端已经按下面的协议固定写好，改服务端时请保持一致。

### `GET /api/health`

```json
{"ok": true}
```

模型已加载返回 `{"ok": true}`，未加载返回 `{"ok": false}`。

### `GET /api/system`

```json
{"n_ctx": 2048}
```

返回上下文长度（前端用它估算能塞多少历史）。

### `POST /api/chat`

请求体（JSON）：

```json
{
  "system": "你是小咸鱼……",
  "temperature": 0.6,
  "max_tokens": 768,
  "messages": [{"role": "user", "content": "你好"}]
}
```

响应：`text/event-stream`（SSE），每个增量块一行：

```
data: {"t":"你"}

data: {"t":"好"}

data: [DONE]
```

即每个块的格式是 `data: {"t": "<文本片段>"}\n\n`，结束后发送
`data: [DONE]\n\n`。服务端会真的逐块 flush，不会攒完整段再发。

`system` 会被放在 `messages` 数组的第一条 `{"role":"system"}`。

出错时（例如模型未加载、请求体不合法）返回普通 JSON，
HTTP 状态码 4xx/5xx，形如 `{"error": "..."}`。

命令行验证：

```bash
curl -N -X POST http://127.0.0.1:8000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"system":"你是小咸鱼","temperature":0.6,"max_tokens":128,
       "messages":[{"role":"user","content":"你好"}]}'
```

### 静态文件

`/api/*` 以外的路径都从**工程根目录**读文件：

- `/` → `index.html`
- `/css/style.css`、`/js/app.js`、`/avatar.png` 等按原路径
- 已做路径穿越防护：`../`、`%2e%2e/` 之类解析到工程根目录之外一律 404

---

## 测试

不依赖真实模型、不下载 1 GB 文件也能跑：

```bash
python3 -m py_compile server/server.py
python3 -m unittest discover -s server -v
```

`test_api.py` 用假模型（`FakeModel`）起一个真的 HTTP 服务，覆盖：

- `/api/health`、`/api/system` 的返回；
- SSE 格式（`data: {"t": ...}` + `data: [DONE]`）、system 消息顺序、参数透传；
- 真正流式：第一块必须在整段生成结束前到达；
- 模型未加载时 `chat` 返回 503；
- 静态文件、MIME、HEAD 请求、路径穿越防护。

---

## 常见问题

### 1. 提示「没有找到 GGUF 模型文件」

先下载模型：

```bash
bash server/download-model.sh
```

脚本会先试 `huggingface-cli`，失败自动回退到 `curl`，并支持断点续传
（中断后重新运行同一个命令即可）。

国内下载慢可以走镜像：

```bash
HF_ENDPOINT=https://hf-mirror.com bash server/download-model.sh
```

也可以自己下载
[`bartowski/Qwen2.5-1.5B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF)
里的 `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`，放进 `models/` 目录。

### 2. 安装 `llama-cpp-python` 很慢 / 编译失败

优先装官方预编译 CPU 轮子：

```bash
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
```

需要从源码编译时，先装编译工具（Ubuntu / proot 环境）：

```bash
apt-get update && apt-get install -y build-essential cmake python3-dev
# 手机上如果 OpenMP 相关报错，可以试试：
CMAKE_ARGS="-DGGML_OPENMP=OFF" pip install -r server/requirements.txt
```

国内 pip 慢：

```bash
pip install -r server/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 3. 端口 8000 被占用

换一个端口：

```bash
python3 server/server.py --port 8001
# 然后打开 http://127.0.0.1:8001/
```

### 4. 手机内存不够 / 推理很慢

- 调小上下文：`--n-ctx 1024`
- 控制线程数：`--threads 2`（太大会让手机发烫）
- 换更小的量化（比如 `Q4_K_S` 或 `Q3_K_M`），放进 `models/` 即可自动识别；
- 只开一个浏览器标签页，别同时跑别的吃内存的应用。

### 5. 页面说「本服务未响应」

说明 `server/server.py` 没在跑，或者端口不对：

```bash
# 检查健康接口
curl http://127.0.0.1:8000/api/health
# 应返回 {"ok":true}
```

改过端口的话，前端是用同源相对路径 `/api/...` 请求的，直接访问
`http://127.0.0.1:<端口>/` 就能连上对应服务。

### 6. 输出很慢 / 一直「思考中」

本地 1.5B 模型在手机上本来就慢，Q4_K_M 大约 1 GB，出字速度一般是每秒几个
token。第一次加载模型也会慢几十秒，属正常现象。

---

## 安全说明

- 默认只监听 `127.0.0.1`，仅本机可访问；
- 用 `--host 0.0.0.0` 暴露到局域网时，任何能连上的设备都能调用接口，
  请只在可信网络里这么用；
- 服务没有鉴权、没有联网上传，所有推理都在本机完成。
