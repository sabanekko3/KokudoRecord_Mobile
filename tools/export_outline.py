#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""海岸線と県境を data/outline.json に書き出す（オフラインでも地形の形が分かるように）。

    python tools/export_outline.py

元データは国土地理院の「地球地図日本」第 2.2 版（1:100 万、shapefile）。
  https://www.gsi.go.jp/kankyochiri/gm_jpn.html
  海岸線 = coastl_jpn、県境 = polbndl_jpn のうち use=26（都道府県界。30 は市町村界）
zip は tools/_gm_japan.zip に落として使い回す（無ければ取りに行く。9MB）。
利用は「国土地理院コンテンツ利用規約」に従い、画面に出典を出す（app.js の OUTLINE_CREDIT）。

出力の座標は lines.json と同じ差分列（1e-7 度単位の整数、Graph.decodeLatLngs で戻す）。
標準ライブラリだけで shapefile と dbf を読む。
"""
from __future__ import annotations

import io
import json
import os
import struct
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
ZIP_URL = "https://www1.gsi.go.jp/geowww/globalmap-gsi/download/data/gm-japan/gm-jpn-all_u_2_2.zip"
ZIP_PATH = os.path.join(HERE, "_gm_japan.zip")
ZIP_DIR = "gm-jpn-all_u_2_2/"
OUT = os.path.join(APP_DIR, "data", "outline.json")
SCALE = 10 ** 7
VERSION = "地球地図日本 2.2 (2016)"


def read_dbf(data: bytes) -> list[dict]:
    """dbf の全レコードを {項目名: 文字列} で返す"""
    n_rec, hdr_len, rec_len = struct.unpack("<IHH", data[4:12])
    fields = []
    pos = 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0")[0].decode("ascii")
        fields.append((name, data[pos + 16]))
        pos += 32
    recs = []
    pos = hdr_len
    for _ in range(n_rec):
        rec = data[pos:pos + rec_len]
        pos += rec_len
        vals = {}
        p = 1
        for name, flen in fields:
            vals[name] = rec[p:p + flen].decode("latin-1").strip()
            p += flen
        recs.append(vals)
    return recs


def read_shp(data: bytes) -> list[list[list[tuple[float, float]]]]:
    """polyline の shapefile。図形ごとに [part, ...]、part は [(経度, 緯度), ...]"""
    pos = 100
    out = []
    while pos < len(data):
        _, clen = struct.unpack(">ii", data[pos:pos + 8])
        pos += 8
        rec = data[pos:pos + clen * 2]
        pos += clen * 2
        if struct.unpack("<i", rec[:4])[0] == 0:       # null shape
            out.append([])
            continue
        nparts, npts = struct.unpack("<ii", rec[36:44])
        parts = struct.unpack("<%di" % nparts, rec[44:44 + 4 * nparts])
        p0 = 44 + 4 * nparts
        flat = struct.unpack("<%dd" % (2 * npts), rec[p0:p0 + 16 * npts])
        pts = [(flat[i], flat[i + 1]) for i in range(0, len(flat), 2)]
        bounds = list(parts) + [npts]
        out.append([pts[bounds[i]:bounds[i + 1]] for i in range(nparts)])
    return out


def encode(part: list[tuple[float, float]]) -> list[int]:
    """[(経度, 緯度), ...] → [x0, y0, dx, dy, ...]（1e-7 度単位）。同じ点の連続は落とす"""
    out: list[int] = []
    px = py = None
    for lon, lat in part:
        x, y = round(lon * SCALE), round(lat * SCALE)
        if px is None:
            out += [x, y]
        elif x != px or y != py:
            out += [x - px, y - py]
        else:
            continue
        px, py = x, y
    return out


def main() -> None:
    if not os.path.exists(ZIP_PATH):
        print("地球地図日本を取りに行きます:", ZIP_URL)
        with urllib.request.urlopen(ZIP_URL, timeout=120) as res:
            data = res.read()
        with open(ZIP_PATH, "wb") as f:
            f.write(data)
        print(f"  {len(data) / 1e6:.1f} MB → {ZIP_PATH}")
    z = zipfile.ZipFile(ZIP_PATH)

    coast = read_shp(z.read(ZIP_DIR + "coastl_jpn.shp"))
    coast_lines = [encode(part) for shape in coast for part in shape if len(part) >= 2]

    bnd_recs = read_dbf(z.read(ZIP_DIR + "polbndl_jpn.dbf"))
    bnd = read_shp(z.read(ZIP_DIR + "polbndl_jpn.shp"))
    pref_lines = [encode(part) for rec, shape in zip(bnd_recs, bnd) if rec["use"] == "26"
                  for part in shape if len(part) >= 2]

    out = {"version": VERSION, "coast": coast_lines, "pref": pref_lines}
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    npts = sum(len(l) // 2 for l in coast_lines + pref_lines)
    print(f"海岸線 {len(coast_lines)} 本、県境 {len(pref_lines)} 本、点 {npts:,}、"
          f"{len(text.encode('utf-8')) / 1e6:.2f} MB → {os.path.relpath(OUT, APP_DIR)}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
