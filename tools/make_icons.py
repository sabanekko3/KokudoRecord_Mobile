#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""アプリのアイコン（PNG）を標準ライブラリだけで描く。

    python tools/make_icons.py

国道標識の形（丸みを帯びた逆三角、白い縁、青い地）に、赤い「走破済みの道」を一本。
192 / 512 / 512(maskable) を icons/ に置く。maskable は青で端まで塗り、
標識を中央 80% の安全域に収める（OS が丸や角丸に切り抜く）。
"""
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")

BLUE = (11, 63, 143)
RED = (216, 31, 38)
WHITE = (255, 255, 255)


def png_bytes(size, pixels):
    """pixels: size*size 個の (r, g, b, a)"""
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixels[y * size + x])

    def chunk(tag, body):
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    sig = bytes([137, 80, 78, 71, 13, 10, 26, 10])
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def poly_sdf(p, verts):
    """凸多角形（頂点は時計回り）への符号付き距離。中は負、外は正"""
    x, y = p
    inside = True
    dmax = -1e9
    dmin = 1e9
    n = len(verts)
    for i in range(n):
        ax, ay = verts[i]
        bx, by = verts[(i + 1) % n]
        ex, ey = bx - ax, by - ay
        L = math.hypot(ex, ey)
        # 辺の直線への符号付き距離（時計回りなら右側＝内側が負）
        s = ((x - ax) * ey - (y - ay) * ex) / L
        if s > 0:
            inside = False
        dmax = max(dmax, s)
        # 線分への距離
        t = max(0.0, min(1.0, ((x - ax) * ex + (y - ay) * ey) / (L * L)))
        dmin = min(dmin, math.hypot(x - (ax + t * ex), y - (ay + t * ey)))
    return dmax if inside else dmin


def cov(d):
    """符号付き距離 d（負が中）を 0〜1 の被覆率に。1px でなめらかにする"""
    return max(0.0, min(1.0, 0.5 - d))


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(len(a)))


def draw(size, maskable):
    c = size / 2
    # 標識の大きさ。maskable は安全域（中央 80%）に収める
    span = size * (0.76 if maskable else 0.92)
    r_corner = span * 0.13                   # 角の丸み
    rim = span * 0.075                       # 白い縁の太さ
    # 逆三角（上辺が水平、頂点が下）。角を丸めるぶん内側に縮めた三角に r_corner を足す
    top = c - span * 0.44
    bottom = c + span * 0.50
    half = span * 0.50
    # 内側に r_corner だけ寄せた三角の頂点（時計回り）
    tri = [(c - half + r_corner * 1.6, top + r_corner), (c + half - r_corner * 1.6, top + r_corner),
           (c, bottom - r_corner * 1.9)]
    road_w = span * 0.14
    px = []
    for y in range(size):
        for x in range(size):
            p = (x + 0.5, y + 0.5)
            d = poly_sdf(p, tri) - r_corner          # 標識の外形（白縁の外側）
            if maskable:
                bg = BLUE + (255,)
            else:
                bg = (0, 0, 0, 0)
            a_out = cov(d)                            # 標識全体
            a_in = cov(d + rim)                       # 白縁の内側（青）
            col = mix(WHITE, BLUE, a_in)
            # 赤い道: 左下から右上へ、少しうねる。縁から離した青い部分にだけ描く
            dx, dy = p[0] - c, p[1] - c + span * 0.04
            off = math.sin((dx + dy) / span * math.pi * 1.1) * span * 0.06
            dist = abs((dy - dx) / math.sqrt(2) - off)
            clip = cov(d + rim + span * 0.055)
            a_road = cov(dist - road_w / 2) * clip
            a_edge = cov(dist - road_w / 2 + span * 0.018) * clip
            col = mix(col, WHITE, a_road)
            col = mix(col, RED, a_edge)
            if maskable:
                px.append(mix(bg[:3], col, a_out) + (255,))
            else:
                a = int(round(255 * a_out))
                px.append(col + (a,))
    return png_bytes(size, px)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, maskable in (("icon-192.png", 192, False), ("icon-512.png", 512, False),
                                 ("icon-512-maskable.png", 512, True)):
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(draw(size, maskable))
        print("wrote", name)


if __name__ == "__main__":
    main()
