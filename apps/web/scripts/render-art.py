#!/usr/bin/env python3
"""Renders the landing art procedurally with numpy. Run: python3 scripts/render-art.py, output in public/art."""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

MONO = "/System/Library/Fonts/Menlo.ttc"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "art")


def fbm(h, w, seed, beta=2.1):
    """Spectral 1/f^beta noise, normalised to 0..1."""
    rng = np.random.default_rng(seed)
    fy = np.fft.fftfreq(h)[:, None] * h
    fx = np.fft.rfftfreq(w)[None, :] * w
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1
    spec = (rng.normal(size=f.shape) + 1j * rng.normal(size=f.shape)) * f ** (-beta / 2)
    n = np.fft.irfft2(spec, s=(h, w))
    return (n - n.min()) / (np.ptp(n) + 1e-9)


def sample(a, x, y):
    """Bilinear sampling with edge clamp."""
    h, w = a.shape[:2]
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = x - x0, y - y0
    if a.ndim == 3:
        fx, fy = fx[..., None], fy[..., None]
    return a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy) + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy


def blur(a, r):
    """Gaussian blur through the FFT."""
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (np.pi * r) ** 2 * (fx * fx + fy * fy))
    if a.ndim == 3:
        return np.stack([np.fft.irfft2(np.fft.rfft2(a[..., c]) * g, s=(h, w)) for c in range(a.shape[2])], axis=-1)
    return np.fft.irfft2(np.fft.rfft2(a) * g, s=(h, w))


def normals(z, strength):
    gy, gx = np.gradient(z)
    n = np.dstack((-gx * strength, -gy * strength, np.ones_like(z)))
    return n / np.linalg.norm(n, axis=2, keepdims=True)


def ramp(t, stops):
    """Colour ramp; stops are (position, (r, g, b))."""
    t = np.clip(t, 0, 1)
    xs = np.array([s[0] for s in stops])
    return np.dstack([np.interp(t, xs, [s[1][c] for s in stops]) for c in range(3)])


def lit(n, light):
    l = np.array(light, float)
    l /= np.linalg.norm(l)
    return np.clip((n * l).sum(axis=2), 0, 1)


def save(name, rgb, seed=7, grain=0.012, quality=78):
    rng = np.random.default_rng(seed)
    rgb = rgb + rng.normal(0, grain, rgb.shape[:2])[..., None]
    img = Image.fromarray((np.clip(rgb, 0, 1) ** (1 / 2.2) * 255).astype("uint8"))
    img.save(os.path.join(OUT, name), quality=quality, method=6)
    print(name, img.size, os.path.getsize(os.path.join(OUT, name)) // 1024, "KB")


def aces(c):
    """Filmic tone curve in linear light."""
    return np.clip((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0, 1)


def ledger(h=1100, w=2000):
    """Rows of account figures seen through frosted glass: sharp at the left, dissolved to light at the right."""
    rng = np.random.default_rng(12)
    font = ImageFont.truetype(MONO, 20)
    sheet = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(sheet)
    for row, y in enumerate(range(18, h, 36)):
        x = 18 + (row % 3) * 22
        while x < w:
            value = rng.integers(1000, 999999)
            cents = rng.integers(0, 99)
            sign = "+" if rng.random() > 0.45 else "-"
            text = f"{sign}{value:,}.{cents:02d}"
            shade = int(rng.integers(55, 190))
            draw.text((x, y), text, fill=shade, font=font)
            x += int(draw.textlength(text)) + int(rng.integers(26, 64))
    figures = (np.asarray(sheet).astype(float) / 255) ** 1.4
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    u, v = xx / w, yy / h
    frost = np.clip((u - 0.14 + (fbm(h, w, 8, 3.0) - 0.5) * 0.18) / 0.62, 0, 1)
    jitter = (frost ** 1.4) * 34
    nx, ny = fbm(h, w, 21, 0.4) - 0.5, fbm(h, w, 22, 0.4) - 0.5
    sharp = figures
    grainy = sample(figures, xx + nx * jitter * 2, yy + ny * jitter * 2)
    mid = blur(grainy, 9)
    far = blur(grainy, 42)
    t = frost[..., None] ** 1.1
    layered = (sharp[..., None] * (1 - np.minimum(t * 3, 1)) + grainy[..., None] * np.minimum(t * 3, 1) * (1 - np.minimum(t * 1.5, 1)) + mid[..., None] * np.minimum(t * 1.5, 1) * (1 - t) + far[..., None] * t)
    warm = np.array([1.0, 0.60, 0.36])
    cool = np.array([0.62, 0.68, 0.72])
    tint = cool * (1 - t) + warm * t
    light = np.exp(-(((u - 0.86) / 0.42) ** 2 + ((v - 0.52) / 0.62) ** 2))[..., None]
    out = layered * tint * (0.11 + light * 1.05) + light * np.array([0.11, 0.05, 0.022]) * 0.55
    # Fade every edge into the carbon page so the art has no frame of its own.
    edge = np.clip(np.minimum.reduce([u * 5, (1 - u) * 5, v * 3.2, (1 - v) * 3.2]), 0, 1)[..., None] ** 1.3
    save("ledger.webp", aces(out * edge + np.array([0.0037, 0.0048, 0.0052]) * (1 - edge)), grain=0.0009, quality=90)


def glow(h=1200, w=2400):
    """A warm light rising behind the product window, falling away to carbon before any edge."""
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    u, v = xx / w, yy / h
    core = np.exp(-(((u - 0.5) / 0.30) ** 2 + ((v - 0.60) / 0.26) ** 2))
    wide = np.exp(-(((u - 0.5) / 0.52) ** 2 + ((v - 0.66) / 0.42) ** 2))
    fade = np.clip(np.minimum.reduce([u * 3.5, (1 - u) * 3.5, v * 2.4, (1 - v) * 2.6]), 0, 1) ** 1.2
    light = (core[..., None] * np.array([0.36, 0.105, 0.024]) + wide[..., None] * np.array([0.085, 0.028, 0.011])) * fade[..., None]
    save("glow.webp", aces(light + np.array([0.0037, 0.0048, 0.0052])), grain=0.0011, quality=93)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    ledger()
    glow()
