#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""アプリのアイコン（PNG）を標準ライブラリだけで描く。

    python tools/make_icons.py

青い丸に赤い「走破済みの道」を一本。192 / 512 / 512(maskable) を icons/ に置く。
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


def draw(size, maskable):
    px = []
    c = size / 2
    # maskable は端まで塗る（OS が丸く切り抜く）。普通のは少し内側に丸を置く
    radius = size * (0.5 if maskable else 0.46)
    road_w = size * 0.17
    for y in range(size):
        for x in range(size):
            dx, dy = x + 0.5 - c, y + 0.5 - c
            d = math.hypot(dx, dy)
            if maskable:
                bg = BLUE + (255,)
            else:
                a = max(0.0, min(1.0, radius - d + 0.5))
                bg = BLUE + (int(255 * a),)
            # 左下から右上へ、少しうねった赤い道
            t = (dx + dy) / (2 * size)
            off = math.sin((dx + dy) / size * math.pi * 1.1) * size * 0.17
            dist = abs((dy - dx) / math.sqrt(2) - off)
            inside = d < radius * (0.96 if not maskable else 0.8)
            if inside and dist < road_w / 2:
                edge = max(0.0, min(1.0, road_w / 2 - dist + 0.5))
                col = RED
                # 白い縁
                if dist > road_w / 2 - size * 0.018:
                    col = WHITE
                px.append(tuple(int(col[i] * edge + bg[i] * (1 - edge)) for i in range(3)) + (bg[3],))
            else:
                px.append(bg)
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
