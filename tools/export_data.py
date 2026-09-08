#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PC 版（国道管理v2）の導出データから、スマホ版の data/ を書き出す。

    python tools/export_data.py [--pc ../国道管理v2]

PC 版には手を入れず、kokudo_map.py を読み込んで cache/derived/ を使うだけ。
書き出すもの:

    data/index.json         路線の一覧（番号・延長・範囲）と全国の総延長
    data/lines.json         全路線の間引いた線（起動時に全国を描く用）
    data/nodes.json         地図に出す地点名（PC 版と同じ配列）
    data/eki.json           道の駅
    data/routes/r{ref}.json 1路線の形状とグラフ（記録のある路線だけ読む）

座標は 1e-7 度単位の整数で持つ。PC 版の node_key と同じ丸めなので、
スマホ側でも「同じ座標＝同じノード」の突き合わせがそのまま成り立つ。
way の座標は先頭だけ絶対値、あとは前の点からの差分（JSON が小さくなる）。
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
DATA_DIR = os.path.join(APP_DIR, "data")

LON_OFFSET = 180 * 10 ** 7
LAT_OFFSET = 90 * 10 ** 7


def key_xy(key, k):
    """node_key → (経度, 緯度) の 1e-7 度単位の整数"""
    return (key >> 32) - LON_OFFSET, (key & k.KEY_MASK) - LAT_OFFSET


def delta_encode(keys, k):
    """node_key の並び → [x0, y0, dx1, dy1, ...]"""
    out = []
    px = py = 0
    for i, key in enumerate(keys):
        x, y = key_xy(key, k)
        if i == 0:
            out += [x, y]
        else:
            out += [x - px, y - py]
        px, py = x, y
    return out


def dump(path, obj):
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    raw = text.encode("utf-8")
    return len(raw), len(gzip.compress(raw, 6))


def mb(n):
    return f"{n / 1024 / 1024:.1f}MB"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pc", default=os.path.join(os.path.dirname(APP_DIR), "国道管理v2"),
                    help="PC 版のフォルダ（kokudo_map.py がある場所）")
    args = ap.parse_args()

    pc = os.path.abspath(args.pc)
    if not os.path.exists(os.path.join(pc, "kokudo_map.py")):
        sys.exit(f"{pc} に kokudo_map.py がありません（--pc で場所を指定してください）")
    sys.path.insert(0, pc)
    import kokudo_map as k   # noqa: E402  BASE_DIR は PC 版のフォルダになる

    t0 = time.time()
    print("PC 版の導出データを読んでいます…", file=sys.stderr)
    data = k.build_data(quiet=True)
    junctions, jsig = data["junctions"], data["jsig"]
    refs = [s["ref"] for s in data["summary"]]

    os.makedirs(os.path.join(DATA_DIR, "routes"), exist_ok=True)
    sizes = {}

    # -- 路線ごと ----------------------------------------------------------
    lines_all = {}
    index_routes = []
    total_pts = 0
    route_raw = route_gz = 0
    for i, ref in enumerate(refs, 1):
        route = k.load_route(ref, junctions, jsig)
        if route is None:
            continue
        heavy = route.heavy
        keys_of, keep_of, edges = heavy["keys"], heavy["keep"], heavy["edges"]

        ways, keeps = [], []
        consecutive = set()
        for wid, keys in keys_of.items():
            if len(keys) < 2:
                continue
            ways.append(delta_encode(keys, k))
            keeps.append("".join("1" if b else "0" for b in keep_of[wid]))
            total_pts += len(keys)
            for a, b in zip(keys, keys[1:]):
                if a != b:
                    consecutive.add((a, b) if a <= b else (b, a))
        # 形状には無いが導出時に繋いだ辺（隙間の橋渡し）。これが無いと経路が切れる
        bridges = [list(key_xy(a, k)) + list(key_xy(b, k))
                   for (a, b) in edges if (a, b) not in consecutive]

        # 地点のキロ程は丸めない値で持つ。PC 版の「本町@104.6」の候補選びは丸める前の
        # 値で行うので、地図に出す 0.1km 刻みの値を使うと同名の地点で選択がずれる
        node_dist = heavy["node_dist"]
        points = []
        for p in route.points:
            km = node_dist.get(k.node_key((p["lon"], p["lat"])))
            points.append([p["name"], p["lat"], p["lon"], p["kind"],
                           None if km is None else round(km, 6)])
        raw, gz = dump(os.path.join(DATA_DIR, "routes", f"r{ref}.json"), {
            "ref": ref, "km": round(route.km, 3), "bounds": route.bounds,
            "ways": ways, "keep": keeps, "bridges": bridges, "points": points,
        })
        route_raw += raw
        route_gz += gz

        # 起動時に全国を描く線。差分の整数で持つ
        light = route.light
        lines_all[ref] = [delta_encode([k.node_key(c) for c in line], k)
                          for line in light["lines"]]
        index_routes.append({"ref": ref, "km": round(route.km, 1), "bounds": route.bounds})
        if i % 50 == 0 or i == len(refs):
            print(f"  {i}/{len(refs)} 路線", file=sys.stderr)

    sizes["routes/*.json"] = (route_raw, route_gz)
    sizes["lines.json"] = dump(os.path.join(DATA_DIR, "lines.json"), lines_all)
    sizes["nodes.json"] = dump(os.path.join(DATA_DIR, "nodes.json"), data["nodes"])
    sizes["eki.json"] = dump(os.path.join(DATA_DIR, "eki.json"),
                             [[e[0], e[1], e[2], e[3]] for e in data["eki"]])
    sizes["index.json"] = dump(os.path.join(DATA_DIR, "index.json"), {
        "version": time.strftime("%Y-%m-%d"),
        "totalKm": data["stats"]["totalKm"],
        "nameSep": k.NAME_SEP,
        "kinds": {"plain": k.KIND_PLAIN, "signal": k.KIND_SIGNAL,
                  "cross": k.KIND_CROSS, "end": k.KIND_END},
        "routes": index_routes,
    })

    print(f"\n{DATA_DIR} に書き出しました（{time.time() - t0:.0f} 秒）")
    print(f"  路線 {len(index_routes)} 本、座標 {total_pts:,} 点、総延長 {data['stats']['totalKm']:,} km")
    print("  ファイル            そのまま     gzip")
    for name, (raw, gz) in sizes.items():
        print(f"  {name:<18} {mb(raw):>9} {mb(gz):>9}")
    raw = sum(v[0] for v in sizes.values())
    gz = sum(v[1] for v in sizes.values())
    print(f"  {'合計':<18} {mb(raw):>9} {mb(gz):>9}")


if __name__ == "__main__":
    main()
