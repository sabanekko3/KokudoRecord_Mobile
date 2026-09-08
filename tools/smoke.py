#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""アプリを http.server で配り、ヘッドレスの Edge で開いて、起動と記録の操作が通ることを見る。

    python tools/smoke.py

見るもの:
  1. 起動が最後まで通る（赤帯が無い、走破率が数字、路線の一覧が出る）
  2. 記録を足す → 走破率が上がる → 走破記録タブに載る → 消す → 戻る
  3. routes.csv の書き出しが PC 版と同じ形になる
  4. 地図を本当にクリックして、地点の印の近く → 地点のポップアップ、線の上 → 線のポップアップ、
     指（pointer: coarse）のときは当たりが広がる
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

# 地図の中の座標（container point）を画面の座標にして本物のクリックを送る
# 国道どうしの交点に寄せて、まわり 70px に他の地点が無い地点を選ぶ（近い方が拾われるため）
PICK_NODE = """(() => {
  const n0 = NODES.find(n => n[3] === 2 && (n[4] || []).length >= 2);
  for (const z of [15, 16, 17]) {
    map.setView([n0[0], n0[1]], z, { animate: false });
    drawLabels();
    const size = map.getSize();
    const d = drawn.find(d => d.x > 60 && d.y > 60 && d.x < size.x - 60 && d.y < size.y - 60
      && drawn.every(o => o === d || (o.x - d.x) ** 2 + (o.y - d.y) ** 2 >= 70 * 70));
    if (d) return { name: d.n[2], x: d.x, y: d.y, zoom: z, drawn: drawn.length };
  }
  return null;
})()"""
# 表示中の路線の線分の中点で、描いてある地点からどれも 30px 以上離れたもの
PICK_LINE = """(() => {
  const size = map.getSize();
  for (const [ref, l] of routeLayers) {
    const pl = l.todo || l.done;
    if (!pl || !pl._parts) continue;
    for (const part of pl._parts) {
      for (let i = 1; i < part.length; i++) {
        const m = map.layerPointToContainerPoint(part[i - 1].add(part[i]).divideBy(2));
        if (m.x < 30 || m.y < 30 || m.x > size.x - 30 || m.y > size.y - 30) continue;
        if (drawn.every(d => (d.x - m.x) ** 2 + (d.y - m.y) ** 2 >= 30 * 30)) return { ref, x: m.x, y: m.y };
      }
    }
  }
  return null;
})()"""
POPUP = '(document.querySelector(".leaflet-popup-content") || {}).textContent || ""'


def click_map(b, x, y):
    """地図の container point (x, y) を本物のマウスで押す"""
    r = b.eval('(() => { const r = map.getContainer().getBoundingClientRect(); return [r.left, r.top]; })()')
    px, py = r[0] + x, r[1] + y
    b.call("Input.dispatchMouseEvent", type="mouseMoved", x=px, y=py)
    b.call("Input.dispatchMouseEvent", type="mousePressed", x=px, y=py, button="left", clickCount=1)
    b.call("Input.dispatchMouseEvent", type="mouseReleased", x=px, y=py, button="left", clickCount=1)
    time.sleep(0.4)


def check_tap(b, coarse):
    """地図のクリックが地点・線に正しく当たるか。coarse なら指の当たり幅で試す"""
    tap = b.eval("NODE_TAP_PX")
    want = 24 if coarse else 14
    print(f"当たり幅: 地点 {tap}px 線 {b.eval('LINE_TAP_PX')}px（{'指' if coarse else 'マウス'}）")
    ok = tap == want
    b.eval('setSheet("peek"); 0')       # シートが地図を覆っていると押せない
    node = b.eval(PICK_NODE)
    if not node:
        print("まわりに何も無い地点が見つからず、地点のクリックは試せなかった")
        return False
    off = (tap - 3) / 2 ** 0.5           # 斜めに (tap-3)px ずらしても当たる
    b.eval("map.closePopup(); 0")
    click_map(b, node["x"] + off, node["y"] + off)
    text = b.eval(POPUP)
    hit = node["name"] in text and "ここから" in text
    print(f"地点 {node['name']}（倍率 {node['zoom']}）の {tap - 3:.0f}px 横を押す → "
          f"{'地点のポップアップ' if hit else '外れ: ' + repr(text[:40])}")
    ok = ok and hit and b.eval("popupNode && popupNode[2]") == node["name"]
    b.eval("map.closePopup(); 0")
    click_map(b, node["x"] + tap + 12, node["y"])
    text = b.eval(POPUP)
    miss = node["name"] not in text
    print(f"地点から {tap + 12}px 離して押す → {'地点には当たらない' if miss else '地点に当たってしまう'}")
    ok = ok and miss
    line = b.eval(PICK_LINE)
    if line:
        b.eval("map.closePopup(); 0")
        click_map(b, line["x"], line["y"])
        text = b.eval(POPUP)
        hit = "この地点を通る国道" in text and f"国道{line['ref']}号" in text
        print(f"国道{line['ref']}号 の線の上を押す → {'線のポップアップ' if hit else '外れ: ' + text[:40]!r}")
        ok = ok and hit
        b.eval("map.closePopup(); 0")
        click_map(b, line["x"], line["y"] + tap + 15)
        print("線から離して押す →", "何も出ない" if not b.eval(POPUP) else "何か出た: " + b.eval(POPUP)[:30])
    else:
        print("線分が見つからず、線のクリックは試せなかった")
        ok = False
    b.eval("map.closePopup(); map.setView([37.0, 137.5], 6, { animate: false }); 0")
    return ok


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
        url = f"http://127.0.0.1:{PORT}/?debug" + ("&" + sys.argv[1] if len(sys.argv) > 1 else "")
        with Browser(url) as b:
            started = b.wait_for('document.getElementById("pct").textContent !== "–"', 60)
            print(f"起動 {time.time() - t0:.1f} 秒: {'OK' if started else '時間切れ'} | 題名: {b.eval('document.title')}")
            print("ログ:", b.eval('(document.getElementById("dbglog") || {}).textContent || ""').strip().replace("\n", " / "))
            fatal = b.eval('(document.getElementById("fatal") || {}).textContent || ""')
            rows = b.eval('document.querySelectorAll("#list .row").length')
            print("赤帯:", fatal or "なし")
            print("走破率:", b.eval('document.getElementById("pct").textContent'),
                  "| 一覧:", rows, "行")
            ok = started and not fatal and rows > 400

            # 3.4 使い方: 「?」で開き、× で閉じる
            b.eval('document.querySelector(".help-btn").click(); 0')
            opened = not b.eval('document.getElementById("help").hidden')
            b.eval('document.querySelector("[data-help-close]").click(); 0')
            closed = b.eval('document.getElementById("help").hidden')
            print("使い方:", "開く" if opened else "開かない", "→", "閉じる" if closed else "閉じない",
                  "| 見出し:", b.eval('document.querySelectorAll("#help h3").length'), "個")
            ok = ok and opened and closed

            # 3.5 スマホ幅なので下パネルはシート。畳んだ状態で始まり、地図は画面いっぱい
            sheet = b.eval('(() => { const a = document.getElementById("app").clientHeight; '
                           'return { state: sheetState, app: a, map: map.getSize().y, '
                           'side: document.getElementById("side").getBoundingClientRect().height }; })()')
            print(f"シート: {sheet['state']} 高さ {sheet['side']:.0f}px / 地図 {sheet['map']}px / 画面 {sheet['app']}px")
            ok = ok and sheet["state"] == "peek" and sheet["map"] == sheet["app"] and sheet["side"] < sheet["app"] * 0.3
            g = b.eval('(() => { const r = document.getElementById("grip").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()')
            b.call("Input.dispatchMouseEvent", type="mousePressed", x=g[0], y=g[1], button="left", clickCount=1)
            b.call("Input.dispatchMouseEvent", type="mouseReleased", x=g[0], y=g[1], button="left", clickCount=1)
            time.sleep(0.4)
            half = b.eval('[sheetState, document.getElementById("side").getBoundingClientRect().height, '
                          'document.querySelectorAll("#list .row").length > 0 && document.getElementById("list").getBoundingClientRect().height]')
            print(f"つまみを押す → {half[0]} 高さ {half[1]:.0f}px、一覧の高さ {half[2]:.0f}px")
            ok = ok and half[0] == "half" and abs(half[1] - sheet["app"] * 0.55) < 3 and half[2] > 150
            b.eval('setSheet("full"); 0'); time.sleep(0.4)
            full = b.eval('[sheetState, document.getElementById("side").getBoundingClientRect().height, document.getElementById("list").getBoundingClientRect().height]')
            print(f"full → 高さ {full[1]:.0f}px、一覧の高さ {full[2]:.0f}px")
            ok = ok and abs(full[1] - sheet["app"] * 0.92) < 3 and full[2] > sheet["app"] * 0.5
            b.eval('document.querySelector("#list .row .row-main").click(); 0'); time.sleep(0.4)
            print("一覧の1行目を押す →", b.eval('sheetState'), "| 国道1号を選択:", b.eval('selectedRef'))
            ok = ok and b.eval('sheetState') == "peek" and b.eval('selectedRef') == "1"
            b.eval('selectRoute("1"); map.closePopup(); map.setView([37.0, 137.5], 6, { animate: false }); 0')

            # 4. 地図のクリック。ヘッドレスの Edge は pointer: coarse を真と言い、CDP の
            #    エミュレーションでは変えられないので、?pointer= で逆の値にして開き直す
            coarse = b.eval("COARSE")
            ok = check_tap(b, coarse) and ok
            b.call("Page.navigate", url=url + "&pointer=" + ("fine" if coarse else "coarse"))
            time.sleep(1)
            b.wait_for('typeof drawn !== "undefined" && document.getElementById("pct").textContent !== "–"', 60)
            ok = check_tap(b, not coarse) and ok

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
            # 描画順: 赤（走破済み）は青（未走破）より後、道の駅はさらに後に描かれている
            order = b.eval("""(() => { const seq = []; for (let o = featRenderer._drawFirst; o; o = o.next)
              seq.push(o.layer.kind || "eki"); return seq.filter((k, i) => k !== seq[i - 1]).join(">"); })()""")
            print("描画順（青→赤→道の駅）:", order)
            ok = ok and order in ("todo>eki", "todo>done>eki", "todo>done")

            b.eval('showTab("records")')
            print("記録タブ:", b.eval('document.querySelectorAll("#paneRecords .rec").length'), "件")
            csv = b.eval('Store.routesCsv(records)')
            print("routes.csv:", repr(csv[:60]))
            ok = ok and csv.startswith("﻿路線番号,区間,走破日,メモ\n116,R116端(南)〜R116端(北),")

            # 全線走破ボタン（一覧の行 → 帯で確認 → 記録）
            FULL_BTN = """document.querySelector('#list .row[data-ref="116"] button[data-full]')"""
            b.eval('setSheet("full"); filter = "all"; render(); 0')
            b.eval(FULL_BTN + ".click(); 0")
            ask = b.eval('document.getElementById("edit").textContent')
            print("全線走破を押す →", ask.strip()[:50])
            ok = ok and "記録しますか" in ask
            b.eval("""document.querySelector('#edit button[data-full-ok]').click(); 0""")
            b.wait_for('summary.get("116").status === "done"', 30)
            print("記録する →", b.eval('summary.get("116").status'), "| 記録:", b.eval('JSON.stringify(records.map(r => r.section))'),
                  "| 行のボタン:", "残っている" if b.eval("!!" + FULL_BTN) else "消えた")
            ok = ok and b.eval('records.length') == 2 and b.eval('records[1].section') == "全線" and not b.eval("!!" + FULL_BTN)
            b.eval('window.confirm = () => true')
            b.eval('deleteRecord(records[1].id)')
            b.wait_for('records.length === 1 && summary.get("116").status === "partial"', 30)
            b.eval('setSheet("peek"); 0')

            # 道の駅。星を本当に押すと道の駅のポップアップが出て、線のポップアップに取られない
            b.eval('document.getElementById("showEki").checked = true; stackLayers(); '
                   'map.setView([EKI[0][0], EKI[0][1]], 14, { animate: false }); 0')
            pt = b.eval('map.latLngToContainerPoint([EKI[0][0], EKI[0][1]])')
            click_map(b, pt["x"], pt["y"])
            text = b.eval(POPUP)
            print("道の駅の星を押す →", "道の駅のポップアップ" if text.startswith("道の駅") else "外れ: " + repr(text[:40]))
            ok = ok and text.startswith("道の駅")
            b.eval('map.closePopup(); map.setView([37.0, 137.5], 6, { animate: false }); 0')
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
