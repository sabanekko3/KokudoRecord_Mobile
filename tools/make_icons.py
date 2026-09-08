#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""アプリのアイコン（PNG）を標準ライブラリだけで描く。

    python tools/make_icons.py

国道標識の形（丸みを帯びた逆三角、白い縁、青い地）を描き、その真ん中に絵柄
（icons/japan.png、白い日本列島のイラスト）を白で載せる。絵柄の位置と大きさは
下の ART_* で調整する。絵柄のファイルが無ければ標識だけを描く。

絵柄の PNG は、透明な地に白で描かれたもの（アルファが形）を想定する。
アルファの無い PNG なら明るさを形として使う（白い所が絵柄）。

標識の上には文字も載せられる。下の TEXTS に「何を・どこに・どの大きさで」を
書けば、好きな文字列を好きな場所に好きなだけ置ける（既定は左上の「国道」）。
文字は Windows のフォントを GDI で描くので Windows でだけ入る（他の OS では
文字を飛ばして標識と絵柄だけを描く）。

192 / 512 / 512(maskable) を icons/ に置く。maskable は青で端まで塗り、
標識を中央 80% の安全域に収める（OS が丸や角丸に切り抜く）。
"""
import math
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")

BLUE = (11, 63, 143)
WHITE = (255, 255, 255)

# ---- 絵柄の調整 ----------------------------------------------------------------
ART = os.path.join(OUT, "japan.png")   # 絵柄の PNG。無ければ標識だけ
ART_WIDTH = 0.45       # 絵柄の幅。標識の幅（白縁の外側どうし）に対する割合
ART_DX = 0.05           # 絵柄の中心の左右のずれ。標識の幅に対する割合（右が正）
ART_DY = -0.05           # 絵柄の中心の上下のずれ。標識の高さに対する割合（下が正）
ART_ANCHOR = 0.40      # 「絵柄の中心」を標識の青い部分の上端から何割の高さに置くか（0.33 で重心）
ART_COLOR = WHITE      # 絵柄の色
ART_TRIM = True        # 絵柄の透明な余白を切り落としてから大きさを合わせる

# ---- 文字の調整 ----------------------------------------------------------------
TEXT_FONT = "Yu Gothic"   # 既定のフォント名（ゴシック体）。無ければ Windows が似た物に替える
TEXT_BOLD = True          # 既定で太字にするか
TEXT_EM = 256             # 文字を一度この大きさ（px）で描いてから縮める。大きいほど滑らか

# 標識に載せる文字。辞書を足せばいくつでも置ける（[] にすれば文字なし）。
#   text    … 文字列。"\n" で改行できる
#   size    … 文字の大きさ（フォントの em）。標識の幅（白縁の外側どうし）に対する割合
#   x, y    … 置き場所。標識の左上を (0, 0)、右下を (1, 1) とした座標
#   anchor  … (x, y) に文字のどこを合わせるか。
#             ("left"|"center"|"right", "top"|"middle"|"bottom")。既定は ("left", "top")
#   color   … 色。既定は白
#   font    … フォント名。省略すると TEXT_FONT
#   bold    … 太字。省略すると TEXT_BOLD
#   italic  … 斜体。省略すると False
# 位置合わせは「実際に墨の乗る範囲」で行う（フォントの余白は数えない）ので、
# anchor が ("left", "top") なら文字の左上の角が (x, y) に来る。
TEXTS = [
    {"text": "国道", "size": 0.13, "x": 0.23, "y": 0.14, "anchor": ("left", "top")},
]


# ---- PNG の読み書き ------------------------------------------------------------
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


def read_png_mask(path):
    """PNG を読んで、絵柄の濃さ（0.0〜1.0）の格子 (w, h, [w*h の float]) を返す。
    アルファがあればアルファ、無ければ明るさ。8 ビット・非インターレースだけ扱う"""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != bytes([137, 80, 78, 71, 13, 10, 26, 10]):
        raise ValueError("PNG ではありません")
    pos = 8
    w = h = depth = ctype = interlace = 0
    idat = bytearray()
    palette = b""
    trns = b""
    while pos < len(data):
        n = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        if tag == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif tag == b"PLTE":
            palette = body
        elif tag == b"tRNS":
            trns = body
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + n
    if depth != 8:
        raise ValueError(f"ビット深度 {depth} は扱えません（8 にして保存し直してください）")
    if interlace:
        raise ValueError("インターレース PNG は扱えません（インターレース無しで保存し直してください）")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(bytes(idat))
    stride = w * channels
    out = bytearray(stride * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        bpp = channels
        if ftype == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif ftype == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ftype == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line

    mask = [0.0] * (w * h)
    has_alpha = ctype in (4, 6) or (ctype == 3 and trns)
    for i in range(w * h):
        px = out[i * channels:(i + 1) * channels]
        if ctype == 6:
            r, g, b, a = px
        elif ctype == 2:
            r, g, b = px
            a = 255
        elif ctype == 4:
            r = g = b = px[0]
            a = px[1]
        elif ctype == 0:
            r = g = b = px[0]
            a = 255
        else:  # パレット
            k = px[0]
            r, g, b = palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2]
            a = trns[k] if k < len(trns) else 255
        lum = (r * 299 + g * 587 + b * 114) / 255000.0
        mask[i] = a / 255.0 if has_alpha else lum
    # アルファがあっても全部不透明なら（白い地に描いてある）、明るさを形にする
    if has_alpha and min(mask) >= 0.99:
        for i in range(w * h):
            px = out[i * channels:(i + 1) * channels]
            r, g, b = (px[0], px[1], px[2]) if channels >= 3 else (px[0], px[0], px[0])
            mask[i] = (r * 299 + g * 587 + b * 114) / 255000.0
    return w, h, mask


def trim(w, h, mask, threshold=0.02):
    """絵柄の入っている範囲 (x0, y0, x1, y1) を返す（x1, y1 は含まない）"""
    xs = [i % w for i, v in enumerate(mask) if v > threshold]
    ys = [i // w for i, v in enumerate(mask) if v > threshold]
    if not xs:
        return 0, 0, w, h
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


class Mask:
    """濃さ（0.0〜1.0）の格子。絵柄にも文字にも使う。
    積分画像で、アイコンの 1 画素に当たる範囲の平均を O(1) で読む"""

    def __init__(self, w, h, mask, do_trim=True):
        self.w, self.h = w, h
        self.box = trim(w, h, mask) if do_trim else (0, 0, w, h)
        W, H = w, h
        acc = [0.0] * ((W + 1) * (H + 1))
        for y in range(H):
            s = 0.0
            for x in range(W):
                s += mask[y * W + x]
                acc[(y + 1) * (W + 1) + (x + 1)] = acc[y * (W + 1) + (x + 1)] + s
        self.acc = acc

    def mean(self, x0, y0, x1, y1):
        """絵柄の画素座標の矩形 [x0,x1)×[y0,y1) の平均（範囲外は 0）"""
        x0 = max(0, min(self.w, x0)); x1 = max(0, min(self.w, x1))
        y0 = max(0, min(self.h, y0)); y1 = max(0, min(self.h, y1))
        if x1 <= x0 or y1 <= y0:
            return 0.0
        W1 = self.w + 1
        a = self.acc
        s = a[y1 * W1 + x1] - a[y0 * W1 + x1] - a[y1 * W1 + x0] + a[y0 * W1 + x0]
        return s / ((x1 - x0) * (y1 - y0))


def load_art(path):
    """絵柄の PNG を Mask にする"""
    w, h, mask = read_png_mask(path)
    return Mask(w, h, mask, ART_TRIM)


# ---- 文字 --------------------------------------------------------------------
def render_text(text, font, em, bold, italic):
    """文字列を em px の大きさで描いて Mask にする（Windows の GDI を使う）。
    返す Mask の box は墨の乗った範囲。em は「フォントの大きさ」の目安として持っておく"""
    if os.name != "nt":
        raise RuntimeError("文字を描けるのは Windows だけです")
    import ctypes
    from ctypes import wintypes

    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    class RECT(ctypes.Structure):
        _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                    ("right", wintypes.LONG), ("bottom", wintypes.LONG)]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                    ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]

    gdi32.CreateFontW.restype = wintypes.HANDLE
    gdi32.CreateFontW.argtypes = ([ctypes.c_int] * 5 + [wintypes.DWORD] * 8 + [wintypes.LPCWSTR])
    gdi32.CreateCompatibleDC.restype = wintypes.HANDLE
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HANDLE]
    gdi32.SelectObject.restype = wintypes.HANDLE
    gdi32.SelectObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    gdi32.CreateDIBSection.restype = wintypes.HANDLE
    gdi32.CreateDIBSection.argtypes = [wintypes.HANDLE, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
                                       ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
    gdi32.GetTextFaceW.restype = ctypes.c_int
    gdi32.GetTextFaceW.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPWSTR]
    # 引数の型を言わないと ctypes はハンドル（大きな値）を int と見て溢れる
    gdi32.PatBlt.argtypes = [wintypes.HANDLE] + [ctypes.c_int] * 4 + [wintypes.DWORD]
    gdi32.SetBkMode.argtypes = [wintypes.HANDLE, ctypes.c_int]
    gdi32.SetTextColor.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
    gdi32.DeleteDC.argtypes = [wintypes.HANDLE]
    user32.DrawTextW.restype = ctypes.c_int
    user32.DrawTextW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, ctypes.c_int,
                                 ctypes.POINTER(RECT), wintypes.UINT]

    FW = 700 if bold else 400
    DEFAULT_CHARSET, OUT_TT_PRECIS, ANTIALIASED_QUALITY = 1, 4, 4
    DT_CALCRECT, DT_NOPREFIX, DT_NOCLIP = 0x400, 0x800, 0x100
    BLACKNESS, TRANSPARENT = 0x42, 1
    flags = DT_NOPREFIX | DT_NOCLIP           # DT_LEFT | DT_TOP は 0

    hdc = gdi32.CreateCompatibleDC(None)
    hfont = gdi32.CreateFontW(-int(em), 0, 0, 0, FW, 1 if italic else 0, 0, 0,
                              DEFAULT_CHARSET, OUT_TT_PRECIS, 0, ANTIALIASED_QUALITY, 0, font)
    if not hdc or not hfont:
        raise RuntimeError("GDI のデバイスコンテキストかフォントを作れません")
    old_font = gdi32.SelectObject(hdc, hfont)
    buf = ctypes.create_unicode_buffer(64)
    gdi32.GetTextFaceW(hdc, 64, buf)
    used = buf.value

    box = RECT(0, 0, 0, 0)
    user32.DrawTextW(hdc, text, -1, ctypes.byref(box), flags | DT_CALCRECT)
    pad = max(4, int(em // 4))                # 縁が欠けないように余白を取る
    w = max(1, box.right - box.left) + pad * 2
    h = max(1, box.bottom - box.top) + pad * 2

    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = w
    bmi.bmiHeader.biHeight = -h               # 上から下へ並べる
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bits = ctypes.c_void_p()
    hbm = gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    if not hbm:
        raise RuntimeError("GDI のビットマップを作れません")
    old_bm = gdi32.SelectObject(hdc, hbm)
    gdi32.PatBlt(hdc, 0, 0, w, h, BLACKNESS)  # 黒で塗り、白い文字の明るさを濃さにする
    gdi32.SetBkMode(hdc, TRANSPARENT)
    gdi32.SetTextColor(hdc, 0x00FFFFFF)
    draw_box = RECT(pad, pad, pad + (box.right - box.left), pad + (box.bottom - box.top))
    user32.DrawTextW(hdc, text, -1, ctypes.byref(draw_box), flags)

    raw = (ctypes.c_ubyte * (w * h * 4)).from_address(bits.value)
    mask = [0.0] * (w * h)
    for i in range(w * h):
        b, g, r = raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2]
        mask[i] = max(b, g, r) / 255.0

    gdi32.SelectObject(hdc, old_bm)
    gdi32.SelectObject(hdc, old_font)
    gdi32.DeleteObject(hbm)
    gdi32.DeleteObject(hfont)
    gdi32.DeleteDC(hdc)

    m = Mask(w, h, mask, True)
    m.em = em
    m.face = used
    return m


def load_texts():
    """TEXTS を描いて [(設定, Mask), ...] にする。描けない環境なら空"""
    out = []
    for spec in TEXTS:
        font = spec.get("font", TEXT_FONT)
        m = render_text(spec["text"], font, TEXT_EM,
                        spec.get("bold", TEXT_BOLD), spec.get("italic", False))
        # 実際に使われた face 名を出す（日本語名が返ることも、無いフォントなら
        # 別のに替わっていることもある）
        note = "" if m.face == font else f"（指定は {font}）"
        print(f"文字: {spec['text']!r} フォント {m.face}{note}、墨の範囲 {m.box}")
        out.append((spec, m))
    return out


# ---- 標識 --------------------------------------------------------------------
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
        s = ((x - ax) * ey - (y - ay) * ex) / L
        if s > 0:
            inside = False
        dmax = max(dmax, s)
        t = max(0.0, min(1.0, ((x - ax) * ex + (y - ay) * ey) / (L * L)))
        dmin = min(dmin, math.hypot(x - (ax + t * ex), y - (ay + t * ey)))
    return dmax if inside else dmin


def cov(d):
    """符号付き距離 d（負が中）を 0〜1 の被覆率に。1px でなめらかにする"""
    return max(0.0, min(1.0, 0.5 - d))


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(len(a)))


def place(mask, scale, ax0, ay0, color):
    """載せ物ひとつ。mask の box の左上がアイコンの (ax0, ay0) に来るように scale 倍で置く。
    描く範囲（アイコン px の矩形）も持たせておく（画素ごとの判定を省くため）"""
    bx0, by0, bx1, by1 = mask.box
    return {"mask": mask, "scale": scale, "ax0": ax0, "ay0": ay0, "color": color,
            "rect": (ax0, ay0, ax0 + (bx1 - bx0) * scale, ay0 + (by1 - by0) * scale)}


def text_overlays(texts, span, top, height, left):
    """TEXTS の設定を、標識の大きさに合わせた載せ物に直す"""
    out = []
    for spec, m in texts:
        scale = spec["size"] * span / m.em          # アイコン px / 描いたときの px
        bx0, by0, bx1, by1 = m.box
        bw, bh = (bx1 - bx0) * scale, (by1 - by0) * scale
        px = left + spec["x"] * span
        py = top + spec["y"] * height
        ax, ay = spec.get("anchor", ("left", "top"))
        px -= {"left": 0.0, "center": bw / 2, "right": bw}[ax]
        py -= {"top": 0.0, "middle": bh / 2, "bottom": bh}[ay]
        out.append(place(m, scale, px, py, spec.get("color", WHITE)))
    return out


def draw(size, maskable, art, texts):
    c = size / 2
    span = size * (0.76 if maskable else 0.92)     # 標識の大きさ（幅）
    r_corner = span * 0.13                         # 角の丸み
    rim = span * 0.075                             # 白い縁の太さ
    top = c - span * 0.44
    bottom = c + span * 0.50
    half = span * 0.50
    # 角を丸めるぶん内側に縮めた三角（時計回り）に r_corner を足して丸い逆三角にする
    tri = [(c - half + r_corner * 1.6, top + r_corner), (c + half - r_corner * 1.6, top + r_corner),
           (c, bottom - r_corner * 1.9)]

    # 載せ物（絵柄・文字）の置き場所。並べた順に上へ重なる
    over = []
    if art:
        bx0, by0, bx1, by1 = art.box
        aw = span * ART_WIDTH                          # 絵柄の幅
        scale = aw / (bx1 - bx0)                       # アイコン px / 絵柄 px
        ah = (by1 - by0) * scale
        cx = c + span * ART_DX
        cy = (top + rim) + (bottom - rim - (top + rim)) * ART_ANCHOR + (bottom - top) * ART_DY
        over.append(place(art, scale, cx - aw / 2, cy - ah / 2, ART_COLOR))
    over += text_overlays(texts, span, top, bottom - top, c - half)

    px = []
    for y in range(size):
        for x in range(size):
            d = poly_sdf((x + 0.5, y + 0.5), tri) - r_corner
            a_out = cov(d)                            # 標識全体（白縁の外側）
            a_in = cov(d + rim)                       # 白縁の内側（青）
            col = mix(WHITE, BLUE, a_in)
            for o in over:
                rx0, ry0, rx1, ry1 = o["rect"]
                if x + 1 <= rx0 or x >= rx1 or y + 1 <= ry0 or y >= ry1:
                    continue
                # このアイコン画素に当たる載せ物の範囲の平均を取る（縮小のにじみ防止）
                m, s = o["mask"], o["scale"]
                bx0, by0 = m.box[0], m.box[1]
                sx0 = bx0 + (x - o["ax0"]) / s
                sx1 = bx0 + (x + 1 - o["ax0"]) / s
                sy0 = by0 + (y - o["ay0"]) / s
                sy1 = by0 + (y + 1 - o["ay0"]) / s
                v = m.mean(int(math.floor(sx0)), int(math.floor(sy0)),
                           int(math.ceil(sx1)), int(math.ceil(sy1)))
                col = mix(col, o["color"], v * a_in)  # 青い部分にだけ載せる
            if maskable:
                px.append(mix(BLUE, col, a_out) + (255,))
            else:
                px.append(col + (int(round(255 * a_out)),))
    return png_bytes(size, px)


def main():
    os.makedirs(OUT, exist_ok=True)
    art = None
    if os.path.exists(ART):
        try:
            art = load_art(ART)
            print(f"絵柄: {os.path.relpath(ART)} {art.w}x{art.h}、使う範囲 {art.box}")
        except Exception as err:
            sys.exit(f"絵柄 {ART} を読めません: {err}")
    else:
        print(f"絵柄 {os.path.relpath(ART)} が無いので標識だけを描きます")
    texts = []
    if TEXTS:
        try:
            texts = load_texts()
        except Exception as err:
            print(f"文字を描けないので飛ばします: {err}")
    for name, size, maskable in (("icon-192.png", 192, False), ("icon-512.png", 512, False),
                                 ("icon-512-maskable.png", 512, True)):
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(draw(size, maskable, art, texts))
        print("wrote", name)


if __name__ == "__main__":
    main()
