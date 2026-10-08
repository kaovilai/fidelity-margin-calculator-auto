#!/usr/bin/env python3
"""Regenerates icons/icon-{16,32,48,128}.png from icons/icon.svg.

macOS only (uses Quick Look to rasterize the SVG) and needs Pillow:  pip3 install pillow
Run from anywhere:  python3 icons/generate.py

Quick Look composites on white, so the badge's rounded-square shape (x=4..124, rx=28 in the 128
viewBox) is re-applied as an alpha mask, then the 1024px render is downsampled to each size.
"""
import pathlib
import subprocess
import tempfile

from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent
SIZES = (128, 48, 32, 16)
BIG = 1024
SUPERSAMPLE = 4


def main():
    with tempfile.TemporaryDirectory() as tmp:
        big_svg = pathlib.Path(tmp) / "big.svg"
        big_svg.write_text((HERE / "icon.svg").read_text().replace('width="128" height="128"', f'width="{BIG}" height="{BIG}"'))
        subprocess.run(["qlmanage", "-t", "-s", str(BIG), "-o", tmp, str(big_svg)], check=True, capture_output=True)
        src = Image.open(pathlib.Path(tmp) / "big.svg.png").convert("RGB")

    k = BIG / 128
    ss = SUPERSAMPLE
    mask = Image.new("L", (BIG * ss, BIG * ss), 0)
    # inset 1px so no white fringe from the Quick Look background survives at the edge
    ImageDraw.Draw(mask).rounded_rectangle(
        [(4 * k + 1) * ss, (4 * k + 1) * ss, (124 * k - 1) * ss, (124 * k - 1) * ss], radius=28 * k * ss, fill=255)
    src.putalpha(mask.resize((BIG, BIG), Image.LANCZOS))

    for n in SIZES:
        src.resize((n, n), Image.LANCZOS).save(HERE / f"icon-{n}.png", optimize=True)
        print(f"wrote icons/icon-{n}.png")


if __name__ == "__main__":
    main()
