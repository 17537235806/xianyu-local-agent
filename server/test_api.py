#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""server/test_api.py

不依赖真实模型的最小接口测试：
  * 用假模型（FakeModel）模拟 llama-cpp-python 的流式输出
  * 起一个真的 ThreadingHTTPServer，用 http.client 走真实 HTTP 路由
  * 验证 SSE 格式、system 消息位置、静态文件、路径穿越防护等

运行方式（在工程根目录）：
    python3 -m unittest discover -s server -v
或：
    python3 server/test_api.py -v
"""

import http.client
import json
import os
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import server  # noqa: E402 - 先补 sys.path 再导入同目录的 server.py


# ---------------------------------------------------------------------------
# 假模型：行为对齐 llama_cpp.Llama.create_chat_completion(stream=True)
# ---------------------------------------------------------------------------

class FakeModel:
    def __init__(self, chunks, delay_after_first=0.0):
        self.chunks = list(chunks)
        self.delay_after_first = delay_after_first
        self.calls = []

    def create_chat_completion(self, messages=None, stream=False,
                               temperature=0.7, max_tokens=256, **kwargs):
        self.calls.append({
            "messages": messages,
            "stream": stream,
            "temperature": temperature,
            "max_tokens": max_tokens,
        })
        for index, text in enumerate(self.chunks):
            if index == 1 and self.delay_after_first:
                time.sleep(self.delay_after_first)
            yield {"choices": [{"delta": {"content": text}, "finish_reason": None}]}
        # llama.cpp 最后一块通常是空 delta + finish_reason，服务端应跳过
        yield {"choices": [{"delta": {}, "finish_reason": "stop"}]}


class ServerTestMixin:
    """每个测试方法起一个独立服务，端口用 0 让系统分配。"""

    def start_server(self, app):
        self.httpd = server.create_server(app, port=0)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

    def _stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(conn.close)
        conn.request(method, path, body=body, headers=headers or {})
        return conn.getresponse()

    def post_chat(self, payload):
        body = json.dumps(payload).encode("utf-8")
        return self.request("POST", "/api/chat", body=body,
                            headers={"Content-Type": "application/json"})

    @staticmethod
    def read_json(resp):
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# 接口测试（模型用假的）
# ---------------------------------------------------------------------------

class ChatApiTest(ServerTestMixin, unittest.TestCase):
    def setUp(self):
        self.model = FakeModel(["你", "好", "呀"])
        self.app = server.App(model=self.model, n_ctx=1234)
        self.start_server(self.app)

    def test_health_ok(self):
        resp = self.request("GET", "/api/health")
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.read_json(resp), {"ok": True})

    def test_system_returns_n_ctx(self):
        resp = self.request("GET", "/api/system")
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.read_json(resp), {"n_ctx": 1234})

    def test_chat_sse_format_and_mock_params(self):
        payload = {
            "system": "你是小咸鱼",
            "temperature": 0.6,
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "你好"}],
        }
        resp = self.post_chat(payload)
        self.assertEqual(resp.status, 200)

        ctype = resp.getheader("Content-Type") or ""
        self.assertTrue(ctype.startswith("text/event-stream"), ctype)

        raw = resp.read().decode("utf-8")
        self.assertTrue(raw.endswith("\n\n"), repr(raw))

        blocks = [b for b in raw.split("\n\n") if b.strip()]
        self.assertTrue(blocks, "没有收到任何 SSE 事件")
        for block in blocks:
            self.assertTrue(block.startswith("data: "), repr(block))

        payloads = [block[len("data: "):] for block in blocks]
        self.assertEqual(payloads[-1], "[DONE]")

        pieces = []
        for line in payloads[:-1]:
            obj = json.loads(line)
            self.assertEqual(set(obj.keys()), {"t"})
            self.assertIsInstance(obj["t"], str)
            pieces.append(obj["t"])

        self.assertEqual(pieces, ["你", "好", "呀"])
        self.assertEqual("".join(pieces), "你好呀")

        # 检查传给模型的参数：system 必须在第一条，且要求流式
        self.assertEqual(len(self.model.calls), 1)
        call = self.model.calls[0]
        self.assertTrue(call["stream"])
        self.assertAlmostEqual(call["temperature"], 0.6)
        self.assertEqual(call["max_tokens"], 64)
        self.assertEqual(call["messages"], [
            {"role": "system", "content": "你是小咸鱼"},
            {"role": "user", "content": "你好"},
        ])

    def test_chat_defaults_and_clamping(self):
        payload = {
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 99,
            "max_tokens": 0,
        }
        resp = self.post_chat(payload)
        self.assertEqual(resp.status, 200)
        resp.read()
        call = self.model.calls[-1]
        self.assertAlmostEqual(call["temperature"], 2.0)
        self.assertEqual(call["max_tokens"], 1)
        # 没传 system 时不应凭空加一条 system
        self.assertEqual(call["messages"], [{"role": "user", "content": "hi"}])

    def test_chat_rejects_bad_json(self):
        resp = self.request("POST", "/api/chat", body=b"not a json",
                            headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 400)
        data = self.read_json(resp)
        self.assertIn("error", data)

    def test_chat_rejects_missing_messages(self):
        body = json.dumps({"system": "x"}).encode("utf-8")
        resp = self.request("POST", "/api/chat", body=body,
                            headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 400)
        self.assertIn("error", self.read_json(resp))

    def test_unknown_api_returns_404(self):
        resp = self.request("GET", "/api/does-not-exist")
        self.assertEqual(resp.status, 404)
        self.assertIn("error", self.read_json(resp))

        resp = self.request("POST", "/api/does-not-exist", body=b"{}",
                            headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 404)
        self.assertIn("error", self.read_json(resp))


class NoModelTest(ServerTestMixin, unittest.TestCase):
    """模型没加载时：health 为 false、system 仍可用、chat 返回 503。"""

    def setUp(self):
        self.app = server.App(model=None, n_ctx=2048)
        self.start_server(self.app)

    def test_health_false(self):
        resp = self.request("GET", "/api/health")
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.read_json(resp), {"ok": False})

    def test_system_still_works(self):
        resp = self.request("GET", "/api/system")
        self.assertEqual(self.read_json(resp), {"n_ctx": 2048})

    def test_chat_returns_503_json(self):
        payload = {"messages": [{"role": "user", "content": "hi"}]}
        resp = self.post_chat(payload)
        self.assertEqual(resp.status, 503)
        data = self.read_json(resp)
        self.assertIn("error", data)


class StreamingTest(ServerTestMixin, unittest.TestCase):
    """验证是真正流式：第一块必须在整段生成结束之前就到达客户端。"""

    def setUp(self):
        self.model = FakeModel(["第一块", "第二块", "第三块"], delay_after_first=1.0)
        self.app = server.App(model=self.model, n_ctx=1024)
        self.start_server(self.app)

    def test_first_chunk_arrives_before_generation_finishes(self):
        payload = {"messages": [{"role": "user", "content": "你好"}]}
        started = time.monotonic()
        resp = self.post_chat(payload)
        self.assertEqual(resp.status, 200)

        first_line = resp.readline()
        first_elapsed = time.monotonic() - started
        self.assertTrue(first_line.startswith(b"data: "), repr(first_line))
        self.assertIn("第一块", first_line.decode("utf-8"))
        self.assertLess(first_elapsed, 0.8,
                        "首个 SSE 块来得太晚，可能没有真正流式输出")

        rest = resp.read()
        total_elapsed = time.monotonic() - started
        self.assertGreaterEqual(total_elapsed, 0.9)
        text = (first_line + rest).decode("utf-8")
        self.assertIn("[DONE]", text)
        self.assertIn("第二块", text)
        self.assertIn("第三块", text)


# ---------------------------------------------------------------------------
# 静态文件测试
# ---------------------------------------------------------------------------

class StaticServeTest(ServerTestMixin, unittest.TestCase):
    def setUp(self):
        # 静态文件直接从工程根目录读（不需要模型）
        self.app = server.App(model=None, n_ctx=2048, root=server.PROJECT_ROOT)
        self.start_server(self.app)

    def test_root_serves_index_html(self):
        resp = self.request("GET", "/")
        self.assertEqual(resp.status, 200)
        ctype = resp.getheader("Content-Type") or ""
        self.assertTrue(ctype.startswith("text/html"), ctype)
        body = resp.read()
        self.assertIn(b"<!DOCTYPE html>", body)
        self.assertIn(b"js/app.js", body)

    def test_js_is_served_with_js_mime(self):
        resp = self.request("GET", "/js/app.js")
        self.assertEqual(resp.status, 200)
        ctype = resp.getheader("Content-Type") or ""
        self.assertTrue(ctype.startswith("text/javascript"), ctype)
        self.assertIn(b"/api/chat", resp.read())

    def test_css_and_image_are_served(self):
        resp = self.request("GET", "/css/style.css")
        self.assertEqual(resp.status, 200)
        resp.read()

        resp = self.request("GET", "/avatar.png")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "image/png")
        resp.read()

    def test_missing_static_returns_404(self):
        resp = self.request("GET", "/no-such-file.txt")
        self.assertEqual(resp.status, 404)
        resp.read()

    def test_path_traversal_blocked(self):
        # 编码后的 ../ 不能把 root 之外的文件读出来
        resp = self.request(
            "GET", "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd"
        )
        self.assertIn(resp.status, (400, 403, 404))
        body = resp.read()
        self.assertNotIn(b"root:", body)

    def test_head_request_has_no_body(self):
        resp = self.request("HEAD", "/index.html")
        self.assertEqual(resp.status, 200)
        self.assertGreater(int(resp.getheader("Content-Length") or 0), 0)
        self.assertEqual(resp.read(), b"")


class ResolvePathUnitTest(unittest.TestCase):
    """直接测路径解析函数，比走 HTTP 更快也更细。"""

    def test_resolve_root_and_index(self):
        root = server.PROJECT_ROOT
        expected = os.path.join(os.path.realpath(root), "index.html")
        self.assertEqual(server.resolve_static_path(root, "/"), expected)
        self.assertEqual(server.resolve_static_path(root, "/index.html"), expected)

    def test_reject_traversal(self):
        root = server.PROJECT_ROOT
        self.assertIsNone(server.resolve_static_path(root, "/../../etc/passwd"))
        self.assertIsNone(server.resolve_static_path(root, "/a/../../../../etc/passwd"))
        # 经过 URL 解码后的 ../ 也一样拦掉
        decoded = server.unquote("/%2e%2e/%2e%2e/etc/passwd")
        self.assertIsNone(server.resolve_static_path(root, decoded))

    def test_reject_missing(self):
        self.assertIsNone(server.resolve_static_path(server.PROJECT_ROOT, "/nope.txt"))


class BuildMessagesUnitTest(unittest.TestCase):
    def test_system_goes_first(self):
        messages = server.build_chat_messages({
            "system": "S",
            "messages": [{"role": "user", "content": "u"}],
        })
        self.assertEqual(messages, [
            {"role": "system", "content": "S"},
            {"role": "user", "content": "u"},
        ])

    def test_skip_empty_system(self):
        messages = server.build_chat_messages({
            "system": "   ",
            "messages": [{"role": "user", "content": "u"}],
        })
        self.assertEqual(messages, [{"role": "user", "content": "u"}])

    def test_invalid_payloads(self):
        self.assertIsNone(server.build_chat_messages({}))
        self.assertIsNone(server.build_chat_messages({"messages": []}))
        self.assertIsNone(server.build_chat_messages(
            {"messages": [{"role": "system", "content": "only system"}]}
        ))


if __name__ == "__main__":
    unittest.main(verbosity=2)
