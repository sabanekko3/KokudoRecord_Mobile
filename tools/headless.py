# -*- coding: utf-8 -*-
"""ヘッドレスの Edge を DevTools Protocol で操る（標準ライブラリだけ）。

`--dump-dom` は仮想時間が尽きた時点の DOM を吐くだけで、IndexedDB のように
仮想時間の外で完了するものを待ってくれない。ここでは実時間で待ち、
Runtime.evaluate で好きな式を評価して結果を取る。動作確認（smoke.py など）に使う。

    with Browser("http://127.0.0.1:8124/") as b:
        b.wait_for('document.getElementById("pct").textContent !== "–"', 60)
        print(b.eval('document.getElementById("pct").textContent'))
"""
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import time
import urllib.request

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
HERE = os.path.dirname(os.path.abspath(__file__))


class WebSocket:
    """最小限の WebSocket クライアント（テキストフレームのみ）"""

    def __init__(self, url):
        assert url.startswith("ws://")
        host, _, path = url[5:].partition("/")
        hostname, _, port = host.partition(":")
        self.sock = socket.create_connection((hostname, int(port or 80)), timeout=120)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /{path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("ハンドシェイクに失敗")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.decode(errors="replace"))
        self.buf = rest

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("接続が切れた")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        data = text.encode("utf-8")
        mask = os.urandom(4)
        head = bytes([0x81])
        n = len(data)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(head + mask + masked)

    def recv(self):
        """1メッセージ（分割フレームは繋ぐ）を文字列で返す"""
        message = b""
        while True:
            b0, b1 = self._recv_exact(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._recv_exact(8))[0]
            if b1 & 0x80:
                mask = self._recv_exact(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._recv_exact(n)))
            else:
                payload = self._recv_exact(n)
            if opcode == 0x9:              # ping → pong
                self.sock.sendall(bytes([0x8A, 0x80]) + b"\x00\x00\x00\x00")
                continue
            if opcode == 0x8:
                raise ConnectionError("閉じられた")
            if opcode in (0x1, 0x2, 0x0):
                message += payload
                if fin:
                    return message.decode("utf-8", errors="replace")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Browser:
    """ヘッドレスの Edge を1枚のページで立ち上げて操る"""

    def __init__(self, url, port=9333, profile=None, window="412,915"):
        self.profile = profile or os.path.join(HERE, "_edgeprofile_cdp")
        shutil.rmtree(self.profile, ignore_errors=True)
        self.proc = subprocess.Popen(
            [EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
             f"--user-data-dir={self.profile}", f"--remote-debugging-port={port}",
             f"--window-size={window}", "--remote-allow-origins=*", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.ws = None
        self.next_id = 0
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as res:
                    targets = json.loads(res.read().decode())
                page = next((t for t in targets if t.get("type") == "page"), None)
                if page:
                    self.ws = WebSocket(page["webSocketDebuggerUrl"])
                    break
            except Exception:
                time.sleep(0.3)
        if self.ws is None:
            self.close()
            raise RuntimeError("Edge に繋げませんでした")
        self.call("Runtime.enable")

    def call(self, method, **params):
        self.next_id += 1
        msg_id = self.next_id
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def eval(self, expression, await_promise=True):
        """式を評価して値を返す（JSON にできる値だけ）。例外はそのまま投げる"""
        r = self.call("Runtime.evaluate", expression=expression, awaitPromise=await_promise,
                      returnByValue=True)
        if "exceptionDetails" in r:
            ex = r["exceptionDetails"]
            desc = (ex.get("exception") or {}).get("description") or ex.get("text")
            raise RuntimeError(f"JS の例外: {desc}")
        return r.get("result", {}).get("value")

    def wait_for(self, expression, timeout=60, interval=0.25):
        """式が真になるまで待つ。時間切れなら False"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.eval(expression, await_promise=False):
                    return True
            except RuntimeError:
                pass
            time.sleep(interval)
        return False

    def close(self):
        if self.ws:
            try:
                self.call("Browser.close")
            except Exception:
                pass
            self.ws.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
