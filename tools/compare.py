#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PC 版と同じ routes.csv を JS 側でも解いて、走破した辺の集合と距離が一致するか確かめる。

    python tools/compare.py [--pc ../国道管理v2] [--csv 記録/routes.csv]

app/ を http.server で配り、ヘッドレスの Edge で _compare.html を開いて JS の結果を DOM から拾う。
都道府県指定の行はスマホ版では扱わないので、比較からも外す。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
PORT = 8123
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

PAGE = """<!DOCTYPE html><meta charset="utf-8"><title>compare</title>
<script src="js/graph.js"></script>
<script>
(async () => {
  const recs = await (await fetch("_test_records.json")).json();
  const byRef = {};
  for (const r of recs) { const ref = Graph.normRef(r.ref); if (!ref) continue; (byRef[ref] = byRef[ref] || []).push(r); }
  const out = {};
  const t0 = performance.now();
  for (const ref of Object.keys(byRef)) {
    const data = await (await fetch(`data/routes/r${ref}.json`)).json();
    const t1 = performance.now();
    const g = new Graph.RouteGraph(data);
    const secs = [], errors = [];
    for (const r of byRef[ref]) {
      const p = Graph.parseRow(r.ref, r.section, r.date, r.note);
      secs.push(...p.items); errors.push(...p.errors);
    }
    const cov = Graph.routeCovered(g, secs);
    const lines = Graph.splitLines(g, cov.covered);
    out[ref] = { n: cov.covered.size, km: cov.doneKm, sections: cov.sections,
                 warnings: cov.warnings.concat(errors), keys: [...cov.covered].sort(),
                 doneLines: lines.done.length, todoLines: lines.todo.length,
                 ms: Math.round(performance.now() - t1), nodes: g.adj.size };
  }
  out._totalMs = Math.round(performance.now() - t0);
  const pre = document.createElement("pre"); pre.id = "out"; pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})().catch(err => { const pre = document.createElement("pre"); pre.id = "err"; pre.textContent = String(err.stack || err); document.body.appendChild(pre); });
</script>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pc", default=os.path.join(os.path.dirname(APP_DIR), "国道管理v2"))
    ap.add_argument("--csv", default=None, help="routes.csv（既定は PC 版の記録）")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    pc = os.path.abspath(args.pc)
    sys.path.insert(0, pc)
    import kokudo_map as k

    # -- Python 側 ----------------------------------------------------------
    csv_path = args.csv or k.CSV_PATH
    rows = []
    import csv as csvmod
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        for row in csvmod.DictReader(f):
            rows.append({"ref": (row.get("路線番号") or "").strip(), "section": (row.get("区間") or "").strip(),
                         "date": (row.get("走破日") or "").strip(), "note": (row.get("メモ") or "").strip()})
    print(f"{csv_path}: {len(rows)} 行")

    data = k.build_data(quiet=True)
    junctions, jsig = data["junctions"], data["jsig"]
    by_ref = {}
    skipped = 0
    for i, r in enumerate(rows, 1):
        for sec in k.parse_row(r["ref"], r["section"], r["date"], r["note"], i, quiet=True):
            if sec["kind"] == "area":
                skipped += 1
                continue
            by_ref.setdefault(sec["ref"], []).append(sec)
    if skipped:
        print(f"  都道府県指定 {skipped} 件は比較から外します")

    def key_str(key):
        a, b = key
        def xy(v):
            return f"{(v >> 32) - 1800000000},{(v & k.KEY_MASK) - 900000000}"
        return xy(a) + "|" + xy(b)

    py = {}
    for ref, secs in by_ref.items():
        route = k.load_route(ref, junctions, jsig)
        if route is None:
            continue
        covered, sections, _d, _n = k.route_covered(route, secs)
        edges = route.edges
        py[ref] = {"n": len(covered), "km": sum(edges[e] for e in covered),
                   "sections": sections, "keys": sorted(key_str(e) for e in covered)}
    print(f"Python: {len(py)} 路線を解きました")

    # -- JS 側 --------------------------------------------------------------
    js_rows = [r for r in rows if not any(s["kind"] == "area" for s in
                                          k.parse_row(r["ref"], r["section"], r["date"], r["note"], quiet=True))]
    with open(os.path.join(APP_DIR, "_test_records.json"), "w", encoding="utf-8") as f:
        json.dump(js_rows, f, ensure_ascii=False)
    with open(os.path.join(APP_DIR, "_compare.html"), "w", encoding="utf-8") as f:
        f.write(PAGE)

    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                               "--directory", APP_DIR], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/_compare.html", timeout=1).read()
                break
            except Exception:
                time.sleep(0.2)
        profile = os.path.join(HERE, "_edgeprofile")
        shutil.rmtree(profile, ignore_errors=True)
        dom_path = os.path.join(HERE, "_compare_dom.html")
        with open(dom_path, "w", encoding="utf-8") as f:
            subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--no-first-run",
                            f"--user-data-dir={profile}", "--virtual-time-budget=60000",
                            "--dump-dom", f"http://127.0.0.1:{PORT}/_compare.html"],
                           stdout=f, stderr=subprocess.DEVNULL, timeout=300)
    finally:
        server.terminate()
        for name in ("_test_records.json", "_compare.html"):
            try:
                os.remove(os.path.join(APP_DIR, name))
            except OSError:
                pass

    dom = open(dom_path, encoding="utf-8").read()
    import html as h
    m = re.search(r'<pre id="err">(.*?)</pre>', dom, re.S)
    if m:
        sys.exit("JS でエラー: " + h.unescape(m.group(1)))
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m:
        sys.exit("JS の出力がありません（時間切れか、スクリプトが止まった）")
    js = json.loads(h.unescape(m.group(1)))
    print(f"JS: {len(js) - 1} 路線を解きました（{js.pop('_totalMs')} ms）")

    # -- 突き合わせ ----------------------------------------------------------
    bad = 0
    for ref in sorted(set(py) | set(js), key=int):
        p, j = py.get(ref), js.get(ref)
        if p is None or j is None:
            print(f"  R{ref}: 片方にしか無い（py={p is not None}, js={j is not None}）")
            bad += 1
            continue
        same_keys = p["keys"] == j["keys"]
        dkm = abs(p["km"] - j["km"])
        mark = "OK" if same_keys and dkm < 0.01 else "NG"
        if mark == "NG":
            bad += 1
        print(f"  {mark} R{ref}: 辺 {p['n']} / {j['n']}  km {p['km']:.3f} / {j['km']:.3f}"
              f"  ノード {j['nodes']}  {j['ms']} ms"
              + ("" if same_keys else f"  辺の集合が違う（共通 {len(set(p['keys']) & set(j['keys']))}）")
              + (f"  警告: {j['warnings']}" if j["warnings"] else ""))
        if p["sections"] != j["sections"]:
            print(f"      区間の表示が違う: {p['sections']} / {j['sections']}")
    print("\n" + ("すべて一致しました" if not bad else f"{bad} 路線で食い違いがあります"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
