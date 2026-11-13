"""Rewatch's mark: an R built from a ring, a stem and a leg (concept 3 from the Codex
round, redrawn with exact geometry). Writes the SVGs and the PNGs every other size is
made from.

    python build_logo.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
RED, DARK = "#e5484d", "#0a0b0e"

# On a 1024 grid, centred. Ring stroke and stem are the same weight (92).
CX, CY, R_OUT, R_IN = 489, 421, 232, 140
STEM = (257, 421, 349, 835)                       # x0, y0, x1, y1
LEG = [(472, 609), (595, 609), (767, 835), (644, 835)]
BOX = (257, 189, 767, 835)                        # the mark's bounds

def shapes_svg(color):
    r_mid, w = (R_OUT + R_IN) / 2, R_OUT - R_IN
    x0, y0, x1, y1 = STEM
    leg = " ".join(f"{x},{y}" for x, y in LEG)
    return (f'<g fill="{color}"><circle cx="{CX}" cy="{CY}" r="{r_mid}" fill="none" stroke="{color}" stroke-width="{w}"/>'
            f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}"/><polygon points="{leg}"/></g>')

def write(name, text):
    open(os.path.join(HERE, name), "w", encoding="utf8", newline="\n").write(text)

# the mark alone, tight to its bounds
bx0, by0, bx1, by1 = BOX
write("rewatch-mark.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{bx0} {by0} {bx1 - bx0} {by1 - by0}">{shapes_svg(RED)}</svg>\n')
# the app icon: the mark on a dark rounded square
write("rewatch-icon.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="224" fill="{DARK}"/>{shapes_svg(RED)}</svg>\n')
# small sizes (favicon, tray): the mark drawn larger on the square so it holds up at 16px
s = 1.28
small = f'<g transform="translate(512 512) scale({s}) translate(-512 -512)">{shapes_svg(RED)}</g>'
write("rewatch-icon-small.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="224" fill="{DARK}"/>{small}</svg>\n')

def render(size, scale=1.0, background=True, ss=4):
    """Draw at 4x and scale down, for clean edges."""
    n = 1024 * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if background:
        d.rounded_rectangle((0, 0, n - 1, n - 1), radius=224 * ss, fill=DARK)
    t = lambda x, y: ((512 + (x - 512) * scale) * ss, (512 + (y - 512) * scale) * ss)
    k = scale * ss
    d.ellipse((*t(CX - R_OUT, CY - R_OUT), *t(CX + R_OUT, CY + R_OUT)), fill=RED)
    d.ellipse((*t(CX - R_IN, CY - R_IN), *t(CX + R_IN, CY + R_IN)), fill=DARK if background else (0, 0, 0, 0))
    d.rectangle((*t(STEM[0], STEM[1]), *t(STEM[2], STEM[3])), fill=RED)
    d.polygon([t(x, y) for x, y in LEG], fill=RED)
    return img.resize((size, size), Image.LANCZOS)

render(1024).save(os.path.join(HERE, "rewatch-icon-1024.png"))
render(1024, 1.28).save(os.path.join(HERE, "rewatch-icon-small-1024.png"))
render(1024, 1.0, background=False).save(os.path.join(HERE, "rewatch-mark-1024.png"))
print("written")
