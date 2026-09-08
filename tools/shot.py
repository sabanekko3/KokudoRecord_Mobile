#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ヘッドレスの Edge でアプリを開いてスクリーンショットを撮る（見た目の確認用）。

    python tools/shot.py [出力.png] [JS の式...]

式を渡すと、起動後に順に評価してから撮る。例:
    python tools/shot.py tools/_shot.png "map.setView([37.45, 138.85], 13)" "$('menuBtn').click()"
"""
import base64
import os
import subprocess
import sys
import time
import urllib.request

from headless import Browser

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
PORT = 8126


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "_shot.png")
    exprs = sys.argv[2:]
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                               "--directory", APP_DIR], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/index.html", timeout=1).read()
                break
            except Exception:
                time.sleep(0.2)
        with Browser(f"http://127.0.0.1:{PORT}/?nosw", port=9334, window="412,915") as b:
            b.wait_for('document.getElementById("pct").textContent !== "–"', 60)
            for e in exprs:
                b.eval(f"void ({e})")      # 返り値（Leaflet の map など）を送り返さない
                time.sleep(0.8)
            time.sleep(1.0)
            r = b.call("Page.captureScreenshot", format="png")
            with open(out, "wb") as f:
                f.write(base64.b64decode(r["data"]))
            print("wrote", out)
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
