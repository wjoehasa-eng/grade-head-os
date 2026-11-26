#!/usr/bin/env python3
"""학년부장 OS 아이콘 생성 (Pillow만 사용).

- 파랑 그라데이션 라운드 사각형
- 흰 카드 + 세 줄(학년 층) + 체크 배지
"""
from PIL import Image, ImageDraw

ROOT = __file__.rsplit("/tools/", 1)[0]
SS = 4
C1 = (78, 155, 255)
C2 = (24, 92, 208)
INK = (27, 95, 208)
MINT = (15, 193, 140)


def gradient(size):
    base = Image.new("RGB", (1, size))
    d = ImageDraw.Draw(base)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), (
            int(C1[0] + (C2[0] - C1[0]) * t),
            int(C1[1] + (C2[1] - C1[1]) * t),
            int(C1[2] + (C2[2] - C1[2]) * t),
        ))
    return base.resize((size, size), Image.BICUBIC)


def draw_icon(size, maskable=False):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = gradient(S).convert("RGBA")

    if maskable:
        mask = Image.new("L", (S, S), 255)
        img.paste(grad, (0, 0))
    else:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255)
        img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    inner = 1.0 if not maskable else 0.78
    unit = S * inner / 100.0
    cx, cy = S / 2, S / 2

    # 흰 카드
    cw, ch = 48 * unit, 46 * unit
    left, top = cx - cw / 2, cy - ch / 2
    d.rounded_rectangle([left, top, left + cw, top + ch], radius=11 * unit, fill=(255, 255, 255, 255))

    # 세 줄 (층)
    bar_x = left + 9 * unit
    bar_w = cw - 18 * unit
    for i, frac in enumerate([1.0, 0.74, 0.48]):
        y = top + 10 * unit + i * 11 * unit
        col = INK if i == 0 else (155, 186, 232)
        d.rounded_rectangle([bar_x, y, bar_x + bar_w * frac, y + 6 * unit], radius=3 * unit, fill=col)

    # 체크 배지
    br = 13 * unit
    bx, by = left + cw - 3 * unit, top + ch - 3 * unit
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=(255, 255, 255, 255))
    d.ellipse([bx - br + 2.2 * unit, by - br + 2.2 * unit, bx + br - 2.2 * unit, by + br - 2.2 * unit], fill=MINT)
    lw = int(2.6 * unit)
    pts = [(bx - 5.4 * unit, by + 0.2 * unit), (bx - 1.6 * unit, by + 3.8 * unit), (bx + 5.8 * unit, by - 4.0 * unit)]
    d.line(pts, fill=(255, 255, 255, 255), width=lw, joint="curve")

    return img.resize((size, size), Image.LANCZOS)


def main():
    for size in (192, 512):
        draw_icon(size).save(f"{ROOT}/icon-{size}.png")
        draw_icon(size, maskable=True).save(f"{ROOT}/icon-{size}-maskable.png")
    draw_icon(512).save(f"{ROOT}/apple-touch-icon.png")
    draw_icon(64).save(f"{ROOT}/favicon.png")
    print("done")


if __name__ == "__main__":
    main()
