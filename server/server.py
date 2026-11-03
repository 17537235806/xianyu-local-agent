#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小咸鱼 · 本地推理服务

一个只用 Python 标准库 http.server 写的极简本地服务：
  * 用 llama-cpp-python 加载 GGUF 模型并流式生成
  * 对外提供 /api/health、/api/system、/api/chat 三个接口
  * 同时把工程根目录的静态前端（index.html / css / js / 图片）直接 serve 出去

依赖只有 llama-cpp-python（推理部分），Web 层不依赖 FastAPI / Flask。

启动示例：
    python3 server/server.py
    python3 server/server.py --port 8000 --n-ctx 4096 --threads 4
"""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import posixpath
import shutil
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

# 工程根目录（server/ 的上一级），静态文件都从这里取
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(PROJECT_ROOT, "models")
DOWNLOAD_SCRIPT = os.path.join("server", "download-model.sh")

# 请求体上限，防止有人往本地服务灌一个超大 JSON
MAX_BODY_BYTES = 4 * 1024 * 1024

# SSE 结束标记（前端依赖这个精确字符串）
SSE_DONE = "data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    """把提示写到 stderr，避免和正常输出混在一起。"""
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def _to_float(value, default: float) -> float:
    """宽松地把请求里的参数转成有限浮点数，非法值回落到默认值。"""
    if isinstance(value, bool):
        return default
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(result):
        return default
    return result


def _to_int(value, default: int) -> int:
    """宽松地把请求里的参数转成整数，非法值回落到默认值。"""
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _delta_text(chunk) -> str:
    """从 llama-cpp-python 的流式 chunk 里取出这一块的文本。"""
    if not isinstance(chunk, dict):
        return ""
    choices = chunk.get("choices")
    if not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta") or {}
    if not isinstance(delta, dict):
        return ""
    text = delta.get("content")
    if isinstance(text, str):
        return text
    return ""


def build_chat_messages(payload):
    """把请求体整理成 llama.cpp 需要的 messages：system 永远排第一。

    返回 None 表示请求不合法（没有 messages，或没有 user/assistant 消息）。
    """
    raw_messages = payload.get("messages")
    if not isinstance(raw_messages, list) or not raw_messages:
        return None

    messages = []
    system = payload.get("system")
    if isinstance(system, str) and system.strip():
        messages.append({"role": "system", "content": system})

    for item in raw_messages:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in ("system", "user", "assistant"):
            continue
        if not isinstance(content, str):
            continue
        messages.append({"role": role, "content": content})

    if not any(item["role"] in ("user", "assistant") for item in messages):
        return None
    return messages


# ---------------------------------------------------------------------------
# 模型查找 / 加载
# ---------------------------------------------------------------------------

def find_default_model(models_dir: str = MODEL_DIR):
    """在 models/ 里自动挑一个 *.gguf；优先 Q4_K_M。"""
    try:
        names = sorted(os.listdir(models_dir))
    except OSError:
        return None

    candidates = []
    for name in names:
        path = os.path.join(models_dir, name)
        if name.lower().endswith(".gguf") and os.path.isfile(path):
            candidates.append(path)
    if not candidates:
        return None

    preferred = [p for p in candidates if "q4_k_m" in os.path.basename(p).lower()]
    return preferred[0] if preferred else candidates[0]


def resolve_model_arg(value):
    """解析 --model 参数；也允许写相对工程根目录的路径。"""
    if not value:
        return find_default_model()

    expanded = os.path.expanduser(value)
    path = os.path.abspath(expanded)
    if os.path.isfile(path):
        return path

    fallback = os.path.abspath(os.path.join(PROJECT_ROOT, expanded))
    if os.path.isfile(fallback):
        return fallback
    return None


def load_model(model_path: str, n_ctx: int, n_threads: int):
    """真正加载 GGUF。单独拆出来方便测试时绕开。"""
    from llama_cpp import Llama  # 延迟导入：没装依赖时也能先跑静态服务/测试

    return Llama(
        model_path=model_path,
        n_ctx=int(n_ctx),
        n_threads=int(n_threads),
        verbose=False,
    )


# ---------------------------------------------------------------------------
# 静态文件：路径解析 + MIME
# ---------------------------------------------------------------------------

MIME_OVERRIDES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
}


def guess_content_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in MIME_OVERRIDES:
        return MIME_OVERRIDES[ext]

    ctype, _encoding = mimetypes.guess_type(path)
    if not ctype:
        return "application/octet-stream"
    if ctype.startswith("text/") and "charset" not in ctype:
        ctype += "; charset=utf-8"
    return ctype


def resolve_static_path(root: str, url_path: str):
    """把 URL 路径安全地映射到 root 下的真实文件；越界/不存在返回 None。

    防路径穿越的做法：先把路径规范化成绝对「虚拟路径」（消掉 . 和 ..），
    再拼到 root 下，最后用 realpath 检查结果仍在 root 内。
    """
    if not isinstance(url_path, str) or "\x00" in url_path:
        return None

    normalized = posixpath.normpath("/" + url_path.lstrip("/"))
    rel = normalized.lstrip("/")
    if not rel:
        rel = "index.html"

    root_real = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_real, *rel.split("/")))
    if target != root_real and not target.startswith(root_real + os.sep):
        return None

    if os.path.isdir(target):
        target = os.path.join(target, "index.html")
    if not os.path.isfile(target):
        return None
    return target


# ---------------------------------------------------------------------------
# 应用状态
# ---------------------------------------------------------------------------

class App:
    """整个服务共享的状态。测试时可以塞一个假模型进来。"""

    def __init__(self, model=None, n_ctx: int = 2048, model_path=None,
                 root=None, verbose: bool = False):
        self.model = model
        self.n_ctx = int(n_ctx)
        self.model_path = model_path
        self.root = os.path.abspath(root or PROJECT_ROOT)
        self.verbose = bool(verbose)
        # llama.cpp 的 Llama 实例不适合多线程同时推理，串行化生成
        self.gen_lock = threading.Lock()


# ---------------------------------------------------------------------------
# HTTP 处理
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "XianyuLocalAgent/1.0"
    sys_version = ""

    # ---------------- 日志 ----------------

    def log_message(self, fmt, *args):
        # 健康检查每 8 秒一次，默认不刷屏；加 --verbose 才打印
        app = getattr(self.server, "app", None)
        if app is not None and not getattr(app, "verbose", False):
            path = getattr(self, "path", "") or ""
            if path.startswith("/api/health"):
                return
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stderr.flush()

    # ---------------- 公共小方法 ----------------

    def _request_path(self) -> str:
        """取出 URL 里去掉 query 之后的路径，并做 URL 解码。"""
        try:
            raw = urlsplit(self.path).path
        except ValueError:
            raw = self.path
        if not raw:
            return "/"
        try:
            path = unquote(raw, encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover - unquote 几乎不会失败
            path = raw
        return path or "/"

    def _send_raw(self, data: bytes) -> bool:
        try:
            self.wfile.write(data)
            self.wfile.flush()
            return True
        except OSError:
            # 客户端已经断开（BrokenPipe / ConnectionReset），安静收摊
            self.close_connection = True
            return False

    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._send_raw(body)

    def _send_text(self, text: str, status: int = 200,
                   ctype: str = "text/plain; charset=utf-8") -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._send_raw(body)

    def _send_sse(self, obj) -> bool:
        line = "data: %s\n\n" % json.dumps(
            obj, ensure_ascii=False, separators=(",", ":")
        )
        return self._send_raw(line.encode("utf-8"))

    def _send_sse_done(self) -> bool:
        return self._send_raw(SSE_DONE.encode("utf-8"))

    def _read_body(self):
        """读取请求体；读不到就自己回错误并返回 None。"""
        length = self.headers.get("Content-Length")
        try:
            size = int(length) if length is not None else 0
        except (TypeError, ValueError):
            size = 0

        if size <= 0:
            self._send_json({"error": "请求体为空（缺少 Content-Length）"}, 400)
            return None
        if size > MAX_BODY_BYTES:
            self.close_connection = True
            self._send_json({"error": "请求体太大"}, 413)
            return None

        try:
            data = self.rfile.read(size)
        except OSError:
            self.close_connection = True
            return None
        if len(data) != size:
            # 客户端中途断了，没必要再回包
            self.close_connection = True
            return None
        return data

    def _discard_body(self) -> None:
        """非 /api/chat 的 POST 也要把请求体吃掉，保持连接状态干净。"""
        length = self.headers.get("Content-Length")
        try:
            size = int(length) if length is not None else 0
        except (TypeError, ValueError):
            size = 0
        if size <= 0:
            return
        if size > MAX_BODY_BYTES:
            self.close_connection = True
            return
        try:
            self.rfile.read(size)
        except OSError:
            self.close_connection = True

    # ---------------- 路由 ----------------

    def do_GET(self):
        try:
            self._handle_get()
        except OSError as exc:
            if isinstance(exc, (BrokenPipeError, ConnectionResetError,
                               ConnectionAbortedError)):
                self.close_connection = True
                return
            self._handle_unexpected(exc)
        except Exception as exc:  # noqa: BLE001 - 兜底，别把 traceback 打给用户
            self._handle_unexpected(exc)

    def do_HEAD(self):
        try:
            path = self._request_path()
            if path.startswith("/api/"):
                self._send_text("", 405)
                return
            self._serve_static(head=True)
        except Exception:
            self.close_connection = True

    def do_POST(self):
        try:
            path = self._request_path()
            if path != "/api/chat":
                self._discard_body()
                self._send_json({"error": "接口不存在：%s" % path}, 404)
                return
            self._handle_chat()
        except OSError as exc:
            if isinstance(exc, (BrokenPipeError, ConnectionResetError,
                               ConnectionAbortedError)):
                self.close_connection = True
                return
            self._handle_unexpected(exc)
        except Exception as exc:  # noqa: BLE001
            self._handle_unexpected(exc)

    def _handle_unexpected(self, exc: Exception) -> None:
        log("[错误] 处理 %s %s 时出错：%s: %s"
            % (getattr(self, "command", "?"), getattr(self, "path", "?"),
               type(exc).__name__, exc))
        try:
            self._send_json({"error": "服务内部错误：%s" % exc}, 500)
        except OSError:
            self.close_connection = True

    # ---------------- GET ----------------

    def _handle_get(self):
        path = self._request_path()
        app = self.server.app

        if path == "/api/health":
            self._send_json({"ok": app.model is not None})
            return

        if path == "/api/system":
            self._send_json({"n_ctx": int(app.n_ctx)})
            return

        if path.startswith("/api/"):
            self._send_json({"error": "接口不存在：%s" % path}, 404)
            return

        self._serve_static(head=False)

    def _serve_static(self, head: bool = False):
        path = self._request_path()
        full_path = resolve_static_path(self.server.app.root, path)
        if full_path is None:
            self._send_text("404 Not Found：文件不存在\n", 404)
            return

        ctype = guess_content_type(full_path)
        try:
            fp = open(full_path, "rb")
        except OSError:
            self._send_text("403 Forbidden：没有权限读取\n", 403)
            return

        with fp:
            try:
                size = os.fstat(fp.fileno()).st_size
            except OSError:
                size = 0
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if head:
                return
            try:
                shutil.copyfileobj(fp, self.wfile)
                self.wfile.flush()
            except OSError:
                self.close_connection = True

    # ---------------- POST /api/chat ----------------

    def _handle_chat(self):
        app = self.server.app

        raw_body = self._read_body()
        if raw_body is None:
            return

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._send_json({"error": "请求体不是合法的 JSON"}, 400)
            return
        if not isinstance(payload, dict):
            self._send_json({"error": "请求体必须是 JSON 对象"}, 400)
            return

        messages = build_chat_messages(payload)
        if messages is None:
            self._send_json(
                {"error": "messages 必须是非空数组，且至少包含一条 user / assistant 消息"},
                400,
            )
            return

        model = app.model
        if model is None:
            self._send_json({"error": "模型还没加载好，请稍后再试"}, 503)
            return

        temperature = _to_float(payload.get("temperature"), 0.6)
        temperature = max(0.0, min(2.0, temperature))
        max_tokens = _to_int(payload.get("max_tokens"), 768)
        max_tokens = max(1, min(8192, max_tokens))

        # 同一时间只允许一个请求推理，避免 Llama 实例被并发调用
        with app.gen_lock:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            # SSE 没有 Content-Length，用关闭连接来告诉客户端数据结束
            self.close_connection = True

            try:
                stream = model.create_chat_completion(
                    messages=messages,
                    stream=True,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                for chunk in stream:
                    text = _delta_text(chunk)
                    if not text:
                        continue
                    if not self._send_sse({"t": text}):
                        return
                self._send_sse_done()
            except OSError:
                self.close_connection = True
            except Exception as exc:  # noqa: BLE001 - 推理失败时给前端一个交代
                log("[错误] 生成回复失败：%s: %s" % (type(exc).__name__, exc))
                try:
                    self._send_sse({"t": "\n\n（推理中断了，请重试。）"})
                    self._send_sse_done()
                except OSError:
                    self.close_connection = True


class LocalHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, app: App):
        self.app = app
        super().__init__(server_address, Handler)


def create_server(app: App, host: str = "127.0.0.1", port: int = 0):
    """创建一个服务实例（port=0 表示让系统随机分配，测试用）。"""
    return LocalHTTPServer((host, int(port)), app)


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="小咸鱼 · 本地推理服务（llama-cpp-python + 标准库 http.server）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "例子：\n"
            "  python3 server/server.py\n"
            "  python3 server/server.py --port 8000 --n-ctx 4096 --threads 4\n"
            "  python3 server/server.py --model models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf\n"
        ),
    )
    parser.add_argument("--model", default=None,
                        help="GGUF 模型路径；默认在 models/ 下自动找 *.gguf")
    parser.add_argument("--host", default="127.0.0.1",
                        help="监听地址，默认 127.0.0.1（只允许本机访问）")
    parser.add_argument("--port", type=int, default=8000,
                        help="监听端口，默认 8000")
    parser.add_argument("--n-ctx", dest="n_ctx", type=int, default=2048,
                        help="上下文长度（token），默认 2048")
    parser.add_argument("--threads", type=int, default=None,
                        help="推理线程数，默认等于 CPU 核心数")
    parser.add_argument("--verbose", action="store_true",
                        help="打印每一次请求（包括健康检查）")
    return parser.parse_args(argv)


def _print_missing_model() -> None:
    out = sys.stderr
    out.write("[错误] 没有找到 GGUF 模型文件。\n\n")
    out.write("服务需要 models/ 下的 *.gguf 模型才能推理。请先下载：\n\n")
    out.write("    cd %s\n" % PROJECT_ROOT)
    out.write("    bash %s\n\n" % DOWNLOAD_SCRIPT)
    out.write("下载约 1 GB（Qwen2.5-1.5B-Instruct Q4_K_M），模型为 Apache-2.0。\n")
    out.write("也可以手动指定模型文件：\n\n")
    out.write("    python3 server/server.py --model /path/to/model.gguf\n\n")
    out.write("默认查找目录：%s\n" % MODEL_DIR)
    out.flush()


def _check_llama_cpp() -> bool:
    try:
        import llama_cpp  # noqa: F401
    except ImportError as exc:
        out = sys.stderr
        out.write("[错误] 没有安装 llama-cpp-python：%s\n\n" % exc)
        out.write("请先安装依赖：\n")
        out.write("    pip install -r server/requirements.txt\n")
        out.write("国内网络慢可以换镜像：\n")
        out.write("    pip install -r server/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple\n")
        out.flush()
        return False
    return True


def main(argv=None) -> int:
    args = parse_args(argv)

    model_path = resolve_model_arg(args.model)
    if model_path is None:
        _print_missing_model()
        return 1

    n_threads = args.threads if (args.threads and args.threads > 0) else max(
        1, os.cpu_count() or 4
    )
    display_host = "127.0.0.1" if args.host in ("", "0.0.0.0", "::") else args.host

    if not _check_llama_cpp():
        return 1

    print("=====================================")
    print("  小咸鱼 · 本地推理服务")
    print("=====================================")
    print("模型：%s" % model_path)
    print("上下文：%d token   线程：%d" % (args.n_ctx, n_threads))
    print("")
    print("[1/2] 正在加载模型…（约 1 GB，手机上可能要等几十秒）", flush=True)

    try:
        model = load_model(model_path, args.n_ctx, n_threads)
    except Exception as exc:  # noqa: BLE001 - 给出人能看懂的提示
        log("[错误] 模型加载失败：%s: %s" % (type(exc).__name__, exc))
        log("")
        log("常见原因：")
        log("  1. 内存不足（手机可以先试 --n-ctx 1024 --threads 2）")
        log("  2. 模型文件没下载完整（重新运行 bash server/download-model.sh）")
        log("  3. llama-cpp-python 没装好（pip install -r server/requirements.txt）")
        return 1

    app = App(model=model, n_ctx=args.n_ctx, model_path=model_path,
              verbose=args.verbose)

    try:
        httpd = create_server(app, args.host, args.port)
    except OSError as exc:
        log("[错误] 无法监听 %s:%d：%s" % (args.host, args.port, exc))
        log("端口可能被占用了，换一个试试：--port 8001")
        return 1

    print("[2/2] 加载完成，服务已启动：", flush=True)
    print("      打开   http://%s:%d/" % (display_host, httpd.server_address[1]))
    print("      接口   GET /api/health  GET /api/system  POST /api/chat")
    print("      按 Ctrl+C 停止服务")
    print("")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭服务…")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
