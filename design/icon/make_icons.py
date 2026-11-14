#!/usr/bin/env python3
"""Draws the app icon options as vector files (glossy red tile, gradients built by hand).

    python3 design/icon/make_icons.py            # writes design/icon/out/option-N.svg and option-N-small.svg

The lettering is Inter Black (SIL Open Font Licence) converted to outlines, so the files render the same on
any machine. Render to PNG with scripts/icons.mjs or design/icon/render.mjs (sharp).
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

OUT = Path(__file__).parent / "out"
FONT = "/usr/share/fonts/opentype/inter/Inter-Black.otf"

# One red family for the tile, from a warm highlight to a deep base.
RED_TOP, RED_MID, RED_LOW, RED_DEEP = "#FF4F43", "#E51F2B", "#9E0A1C", "#5E0410"


def lettering(text: str, height: float, cx: float, baseline: float, fill: str, tracking: float = 0.0) -> str:
    """`text` as outlines, cap height `height`, centred on cx, sitting on `baseline`."""
    font = TTFont(FONT)
    glyphs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font["head"].unitsPerEm
    cap = font["OS/2"].sCapHeight or upm * 0.7
    scale = height / cap
    pieces, x = [], 0.0
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        pieces.append((x, pen.getCommands()))
        x += glyphs[name].width + tracking * upm
    width = (x - tracking * upm) * scale
    left = cx - width / 2
    paths = "".join(
        f'<path transform="translate({left + gx * scale:.2f},{baseline:.2f}) scale({scale:.5f},{-scale:.5f})" d="{d}"/>'
        for gx, d in pieces
    )
    return f'<g fill="{fill}">{paths}</g>'


def defs(extra: str = "") -> str:
    return f"""
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{RED_TOP}"/><stop offset="0.5" stop-color="{RED_MID}"/><stop offset="1" stop-color="{RED_LOW}"/>
    </linearGradient>
    <radialGradient id="bounce" cx="512" cy="1040" r="640" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FF8F7A" stop-opacity="0.85"/><stop offset="0.6" stop-color="#FF8F7A" stop-opacity="0.12"/><stop offset="1" stop-color="#FF8F7A" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.6" stop-color="#fff" stop-opacity="0.13"/><stop offset="1" stop-color="#fff" stop-opacity="0.04"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.85"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.1"/><stop offset="0.7" stop-color="{RED_DEEP}" stop-opacity="0.1"/><stop offset="1" stop-color="{RED_DEEP}" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EEF0F5"/>
    </linearGradient>
    <linearGradient id="paperBack" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFE9E6"/><stop offset="1" stop-color="#F7C9C4"/>
    </linearGradient>
    <linearGradient id="flap" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFF4F2"/><stop offset="1" stop-color="#F3B4AE"/>
    </linearGradient>
    <linearGradient id="label" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FF5A50"/><stop offset="1" stop-color="#C8101F"/>
    </linearGradient>
    <linearGradient id="labelGloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.56" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="tileClip"><rect x="64" y="56" width="896" height="896" rx="208"/></clipPath>
    <filter id="tileShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="20"/><feOffset dy="22"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
      <feFlood flood-color="{RED_DEEP}" result="c"/><feComposite in="c" in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="170%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
    <filter id="softer" x="-30%" y="-30%" width="160%" height="170%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>{extra}
  </defs>"""


def tile() -> str:
    """Glossy red tile: base, light bounced up from below, a curved highlight across the top, a lit rim."""
    return f"""
  <rect x="64" y="56" width="896" height="896" rx="208" fill="{RED_DEEP}" opacity="0.5" filter="url(#soft)" transform="translate(0,26)"/>
  <rect x="64" y="56" width="896" height="896" rx="208" fill="url(#tile)"/>
  <g clip-path="url(#tileClip)">
    <rect x="64" y="56" width="896" height="896" fill="url(#bounce)"/>
    <path d="M64 56 H960 V318 C 748 452, 312 286, 64 432 Z" fill="url(#gloss)"/>
  </g>
  <rect x="67" y="59" width="890" height="890" rx="205" fill="none" stroke="url(#rim)" stroke-width="6"/>"""


def page(x: float, y: float, w: float, h: float, fold: float, r: float = 30, fill: str = "url(#paper)",
         flap: bool = True, shadow: bool = True) -> str:
    """A sheet with a folded top-right corner."""
    body = (f"M{x + r} {y} H{x + w - fold} L{x + w} {y + fold} V{y + h - r} Q{x + w} {y + h} {x + w - r} {y + h} "
            f"H{x + r} Q{x} {y + h} {x} {y + h - r} V{y + r} Q{x} {y} {x + r} {y} Z")
    out = ""
    if shadow:
        out += f'<path d="{body}" fill="{RED_DEEP}" opacity="0.55" filter="url(#soft)" transform="translate(0,20)"/>'
    out += f'<path d="{body}" fill="{fill}"/>'
    if flap:
        fr = min(r, fold * 0.3)
        flap_path = f"M{x + w - fold} {y} V{y + fold - fr} Q{x + w - fold} {y + fold} {x + w - fold + fr} {y + fold} H{x + w} Z"
        out += f'<path d="{flap_path}" fill="{RED_DEEP}" opacity="0.28" filter="url(#softer)" transform="translate(-6,10)"/>'
        out += f'<path d="{flap_path}" fill="url(#flap)"/>'
    return out


def bars(x: float, y: float, widths: list[float], h: float = 26, gap: float = 28, fill: str = "#D5DAE4") -> str:
    return "".join(f'<rect x="{x}" y="{y + i * (h + gap)}" width="{w}" height="{h}" rx="{h / 2}" fill="{fill}"/>'
                   for i, w in enumerate(widths))


def pdf_label(x: float, y: float, w: float, h: float) -> str:
    r = h * 0.26
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="url(#label)"/>'
            f'<rect x="{x + 6}" y="{y + 5}" width="{w - 12}" height="{h * 0.46}" rx="{r * 0.8}" fill="url(#labelGloss)"/>'
            + lettering("PDF", h * 0.5, x + w / 2, y + h * 0.75, "#FFFFFF", tracking=0.035))


def svg(body: str, extra_defs: str = "", grow: float = 1.1) -> str:
    # The drawing sits a little larger than first drawn, about the middle of the tile.
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'{defs(extra_defs)}{tile()}<g transform="translate(512 504) scale({grow}) translate(-512 -504)">{body}</g>\n</svg>\n')


def option_1(small: bool = False) -> str:
    """Page: one sheet with a folded corner and a red PDF label. 'A PDF.'"""
    if small:  # 16 to 32 px: no lettering, a bolder sheet and one red band
        x, y, w, h = 292, 196, 440, 616
        return svg(page(x, y, w, h, 150, r=44) + bars(x + 70, y + 250, [w - 140, w - 140, (w - 140) * 0.6], h=56, gap=52, fill="#C3C9D6"))
    x, y, w, h = 304, 204, 416, 588
    body = page(x, y, w, h, 128)
    body += bars(x + 52, y + 176, [w - 104, w - 104, (w - 104) * 0.62])
    body += pdf_label(x + 44, y + h - 196, w - 88, 140)
    body += f'<path d="{page_outline(x, y, w, h, 128)}" fill="url(#sheen)" opacity="0.5"/>'
    return svg(body)


def page_outline(x, y, w, h, fold, r=30) -> str:
    return (f"M{x + r} {y} H{x + w - fold} L{x + w} {y + fold} V{y + h - r} Q{x + w} {y + h} {x + w - r} {y + h} "
            f"H{x + r} Q{x} {y + h} {x} {y + h - r} V{y + r} Q{x} {y} {x + r} {y} Z")


PEN_DEFS = """
    <linearGradient id="penBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5A6275"/><stop offset="0.28" stop-color="#2B3140"/><stop offset="1" stop-color="#12151D"/>
    </linearGradient>
    <linearGradient id="penGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFE9A6"/><stop offset="0.5" stop-color="#F2B93B"/><stop offset="1" stop-color="#B9791A"/>
    </linearGradient>
    <linearGradient id="penWood" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFE8C8"/><stop offset="1" stop-color="#E0B583"/>
    </linearGradient>"""


def pen(length: float, thick: float) -> str:
    """A pen drawn along the x axis with its point at the origin, pointing left."""
    tip, band = thick * 1.25, thick * 0.34
    body_start = tip + band
    return (
        f'<g>'
        f'<path d="M0 0 L{tip} {-thick / 2} V{thick / 2} Z" fill="url(#penWood)"/>'
        f'<path d="M0 0 L{tip * 0.34} {-thick * 0.136} V{thick * 0.136} Z" fill="#1A1D26"/>'
        f'<rect x="{tip}" y="{-thick / 2}" width="{band}" height="{thick}" fill="url(#penGold)"/>'
        f'<path d="M{body_start} {-thick / 2} H{length - thick / 2} A{thick / 2} {thick / 2} 0 0 1 {length - thick / 2} {thick / 2} H{body_start} Z" fill="url(#penBody)"/>'
        f'<rect x="{body_start + 10}" y="{-thick * 0.34}" width="{length - body_start - thick * 0.9}" height="{thick * 0.13}" rx="{thick * 0.065}" fill="#fff" opacity="0.38"/>'
        f'</g>'
    )


def option_2(small: bool = False) -> str:
    """Edit: a sheet with a pen writing on it. 'A PDF you can change.'"""
    if small:
        x, y, w, h = 250, 196, 420, 600
        body = page(x, y, w, h, 140, r=44)
        body += f'<g transform="translate(470,640) rotate(-45)">{pen(560, 120)}</g>'
        return svg(body, PEN_DEFS)
    x, y, w, h = 268, 204, 404, 580
    body = page(x, y, w, h, 124)
    body += pdf_label(x + 50, y + 62, 168, 70)
    body += bars(x + 50, y + 186, [w - 100, w - 100, w - 100], h=24, gap=30)
    # the line the pen is writing, in the tile's red, ending at its point
    body += f'<rect x="{x + 50}" y="{y + 186 + 3 * 54}" width="{w - 100}" height="24" rx="12" fill="#D5DAE4"/>'
    body += f'<rect x="{x + 50}" y="{y + 186 + 4 * 54}" width="212" height="24" rx="12" fill="url(#label)"/>'
    body += f'<path d="{page_outline(x, y, w, h, 124)}" fill="url(#sheen)" opacity="0.45"/>'
    body += f'<g transform="translate(536,630) rotate(-45)"><g fill="{RED_DEEP}" opacity="0.5" filter="url(#softer)" transform="translate(10,22)"><rect x="0" y="-46" width="470" height="92" rx="40"/></g>{pen(480, 92)}</g>'
    return svg(body, PEN_DEFS)


def option_3(small: bool = False) -> str:
    """Pages: a fan of sheets, the front one labelled PDF. 'Your pages, in order.'"""
    if small:
        body = f'<g transform="rotate(12 512 780)">{page(320, 210, 400, 560, 0, r=44, fill="url(#paperBack)", flap=False)}</g>'
        body += page(272, 226, 420, 590, 140, r=44)
        body += bars(342, 470, [280, 280, 170], h=56, gap=52, fill="#C3C9D6")
        return svg(body)
    body = f'<g transform="rotate(14 512 800)">{page(330, 206, 392, 548, 0, fill="#FBE3E0", flap=False)}</g>'
    body += f'<g transform="rotate(7 512 800)">{page(312, 212, 392, 556, 0, fill="#FFF6F5", flap=False)}</g>'
    x, y, w, h = 280, 228, 400, 568
    body += page(x, y, w, h, 122)
    body += bars(x + 50, y + 170, [w - 100, w - 100, (w - 100) * 0.62])
    body += pdf_label(x + 42, y + h - 188, w - 84, 134)
    body += f'<path d="{page_outline(x, y, w, h, 122)}" fill="url(#sheen)" opacity="0.5"/>'
    return svg(body)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for n, make in enumerate([option_1, option_2, option_3], 1):
        (OUT / f"option-{n}.svg").write_text(make())
        (OUT / f"option-{n}-small.svg").write_text(make(small=True))
    print("wrote", sorted(p.name for p in OUT.glob("*.svg")))
