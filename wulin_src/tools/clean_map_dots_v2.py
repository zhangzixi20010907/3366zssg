# -*- coding: utf-8 -*-
"""移除乌林大地图背景中的紫色圆点：用附近最匹配的纹理块修补。"""
import sys, math
from collections import deque
from PIL import Image, ImageFilter

src = sys.argv[1]
out = sys.argv[2]
im = Image.open(src).convert("RGBA")
W, H = im.size
px = im.load()

# ---- 检测圆点 ----
mask = bytearray(W * H)
for y in range(H):
    for x in range(W):
        r, g, b, a = px[x, y]
        if a > 128 and b > 90 and g < 140 and (b - g) > 22 and (r - g) > 8 and abs(b - r) < 65:
            mask[y * W + x] = 1
seen = bytearray(W * H)
comps = []
for y in range(H):
    for x in range(W):
        i = y * W + x
        if not mask[i] or seen[i]:
            continue
        q = deque([(x, y)]); seen[i] = 1
        n = 0; sx = sy = 0
        while q:
            cx, cy = q.popleft(); n += 1; sx += cx; sy += cy
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < W and 0 <= ny < H:
                    j = ny * W + nx
                    if mask[j] and not seen[j]:
                        seen[j] = 1; q.append((nx, ny))
        if n >= 20:
            comps.append((n, sx / n, sy / n))
comps.sort(reverse=True)
dots = []
for n, cx, cy in comps:
    merged = False
    for d in dots:
        if (d[0] - cx) ** 2 + (d[1] - cy) ** 2 <= 25 * 25:
            total = d[2] + n
            d[0] = (d[0] * d[2] + cx * n) / total
            d[1] = (d[1] * d[2] + cy * n) / total
            d[2] = total
            merged = True
            break
    if not merged:
        dots.append([cx, cy, n])
print("dots:", len(dots))

# 每个点避免作为修补源
def near_dot(x, y, skip, rad=30):
    for i, d in enumerate(dots):
        if i == skip:
            continue
        if (d[0] - x) ** 2 + (d[1] - y) ** 2 <= rad * rad:
            return True
    return False

clean = im.copy()
cpx = clean.load()

# 环采样点
ring = []
for ang in range(0, 360, 6):
    a = math.radians(ang)
    for rad in (23, 26, 29, 32):
        ring.append((math.cos(a) * rad, math.sin(a) * rad))

offsets = []
for dist in (40, 55, 70, 85):
    for ang in range(0, 360, 45):
        a = math.radians(ang)
        offsets.append((math.cos(a) * dist, math.sin(a) * dist))

for idx, (dcx, dcy, _dn) in enumerate(dots):
    cx, cy = int(round(dcx)), int(round(dcy))
    best = None
    for ox, oy in offsets:
        oxi, oyi = int(round(ox)), int(round(oy))
        ok = True
        score = 0.0
        cnt = 0
        for rx, ry in ring:
            x2 = int(round(cx + rx)); y2 = int(round(cy + ry))
            x1 = x2 + oxi; y1 = y2 + oyi
            if not (0 <= x1 < W and 0 <= y1 < H):
                ok = False; break
            if near_dot(x1, y1, idx, 30):
                ok = False; break
            r1, g1, b1, a1 = px[x2, y2]
            r2, g2, b2, a2 = px[x1, y1]
            score += (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2
            cnt += 1
        if ok and cnt > 0:
            avg = score / cnt
            if best is None or avg < best[0]:
                best = (avg, oxi, oyi)
    if best is None:
        # 回退：径向平均色
        acc = [0.0, 0.0, 0.0]; n = 0
        for rx, ry in ring:
            x2 = int(round(cx + rx)); y2 = int(round(cy + ry))
            if 0 <= x2 < W and 0 <= y2 < H:
                r, g, b, a = px[x2, y2]
                acc[0] += r; acc[1] += g; acc[2] += b; n += 1
        col = (int(acc[0] / n), int(acc[1] / n), int(acc[2] / n), 255)
        for y in range(max(0, cy - 22), min(H, cy + 23)):
            for x in range(max(0, cx - 22), min(W, cx + 23)):
                if (x - cx) ** 2 + (y - cy) ** 2 <= 22 * 22:
                    cpx[x, y] = col
        print("  fallback", cx, cy)
        continue

    _, oxi, oyi = best
    for y in range(max(0, cy - 22), min(H, cy + 23)):
        for x in range(max(0, cx - 22), min(W, cx + 23)):
            dx = x - cx; dy = y - cy
            d2 = dx * dx + dy * dy
            if d2 > 22 * 22:
                continue
            x1 = x + oxi; y1 = y + oyi
            if not (0 <= x1 < W and 0 <= y1 < H):
                continue
            r2, g2, b2, a2 = px[x1, y1]
            r1, g1, b1, a1 = px[x, y]
            r = math.sqrt(d2)
            alpha = 1.0 if r <= 18 else max(0.0, (22.0 - r) / 4.0)
            cpx[x, y] = (
                int(r2 * alpha + r1 * (1 - alpha)),
                int(g2 * alpha + g1 * (1 - alpha)),
                int(b2 * alpha + b1 * (1 - alpha)),
                int(a2 * alpha + a1 * (1 - alpha)),
            )

clean.save(out)
print("saved", out)
# 复查紫色
im2 = Image.open(out).convert("RGBA"); p2 = im2.load()
left = 0
for y in range(H):
    for x in range(W):
        r, g, b, a = p2[x, y]
        if a > 128 and b > 90 and g < 140 and (b - g) > 22 and (r - g) > 8 and abs(b - r) < 65:
            left += 1
print("purple pixels left:", left)
