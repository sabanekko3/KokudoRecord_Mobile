#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""アプリを http.server で配り、ヘッドレスの Edge で開いて、起動と記録の操作が通ることを見る。

    python tools/smoke.py

見るもの:
  1. 起動が最後まで通る（赤帯が無い、走破率が数字、路線の一覧が出る）
  2. 記録を足す → 走破率が上がる → 走破記録タブに載る → 消す → 戻る
  3. routes.csv の書き出しが PC 版と同じ形になる
IndexedDB は毎回まっさらな profile なので、最初は 0% から始まる。
"""
import os
import subprocess
import sys
import time
import urllib.request

from headless import Browser

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
PORT = 8124


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                               "--directory", APP_DIR], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = True
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/index.html", timeout=1).read()
                break
            except Exception:
                time.sleep(0.2)
        t0 = time.time()
        with Browser(f"http://127.0.0.1:{PORT}/?debug" + ("&" + sys.argv[1] if len(sys.argv) > 1 else "")) as b:
            started = b.wait_for('document.getElementById("pct").textContent !== "–"', 60)
            print(f"起動 {time.time() - t0:.1f} 秒: {'OK' if started else '時間切れ'}")
            print("ログ:", b.eval('(document.getElementById("dbglog") || {}).textContent || ""').strip().replace("\n", " / "))
            fatal = b.eval('(document.getElementById("fatal") || {}).textContent || ""')
            rows = b.eval('document.querySelectorAll("#list .row").length')
            print("赤帯:", fatal or "なし")
            print("走破率:", b.eval('document.getElementById("pct").textContent'),
                  "| 一覧:", rows, "行")
            ok = started and not fatal and rows > 400

            # 2. 記録を足して消す（国道17号 全線に相当する2地点）
            b.eval('startSection("116", "R116端(南)", "R116端(南)")')
            b.eval('finishSection("116", "R116端(北)", "R116端(北)")')
            b.wait_for('document.getElementById("edit").textContent.includes("記録しました")', 60)
            print("追加:", b.eval('document.getElementById("edit").textContent').strip()[:80])
            pct = b.eval('document.getElementById("pct").textContent')
            n = b.eval('records.length')
            print("走破率:", pct, "| 記録:", n, "件 | 国道116号:",
                  b.eval('JSON.stringify(summary.get("116").status + " " + summary.get("116").doneKm)'))
            ok = ok and n == 1 and pct != "0.0"

            b.eval('showTab("records")')
            print("記録タブ:", b.eval('document.querySelectorAll("#paneRecords .rec").length'), "件")
            csv = b.eval('Store.routesCsv(records)')
            print("routes.csv:", repr(csv[:60]))
            ok = ok and csv.startswith("﻿路線番号,区間,走破日,メモ\n116,R116端(南)〜R116端(北),")

            # 道の駅
            b.eval('toggleEki(0)')
            b.wait_for('visits.size === 1', 10)
            print("道の駅:", b.eval('document.getElementById("detail").textContent').split("道の駅")[-1].strip())

            # 消す
            b.eval('window.confirm = () => true')
            b.eval('deleteRecord(records[0].id)')
            b.wait_for('records.length === 0', 30)
            print("削除後の走破率:", b.eval('document.getElementById("pct").textContent'),
                  "| 国道116号:", b.eval('summary.get("116").status'))
            ok = ok and b.eval('document.getElementById("pct").textContent') == "0.0"

            # 読み込み直しても残っている（IndexedDB）
            b.eval('finishSection("116", "x", "R116端(北)") && 0; startSection("116", "a", "R116端(南)"); 0')
            b.eval('finishSection("116", "R116端(北)", "R116端(北)")')
            b.wait_for('records.length === 1', 60)
            b.call("Page.reload")
            time.sleep(1)
            b.wait_for('typeof records !== "undefined" && records.length === 1 && document.getElementById("pct").textContent !== "–"', 60)
            print("再読み込み後:", b.eval('records.length'), "件 | 走破率", b.eval('document.getElementById("pct").textContent'))
            ok = ok and b.eval('records.length') == 1
    finally:
        server.terminate()
    print("SMOKE OK" if ok else "SMOKE NG")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
