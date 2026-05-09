#!/usr/bin/env python3
"""Shard the three bundled CJK fonts into smaller `unicode-range` subsets.

The full woff2 files in public/fonts total ~22 MB; shipping them eagerly
makes first-paint sluggish on Android WebView. This script runs locally (CI
doesn't need it) and writes per-range subsets the browser will fetch only
when it actually encounters a character in that range.

Requirements:
    pip install fonttools brotli

Usage:
    python3 scripts/split-fonts.py

Output:
    public/fonts/subset/<family>-<slot>.woff2

The slots are:
    - "latin":    Basic Latin + fullwidth punctuation + CJK punctuation
    - "common":   Unified CJK U+4E00-9FFF (3500 most-used chars covered here)
    - "ext":      Extension A + Extension B
The loader CSS lives in src/index.css.
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from fontTools.subset import Subsetter, Options, load_font, save_font
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "fontTools not installed — run `pip install fonttools brotli` first.\n"
    )
    sys.exit(1)


ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "public" / "fonts"
OUT_DIR = SRC_DIR / "subset"

# Fonts to shard. Logical family name → source filename.
FAMILIES: list[tuple[str, str]] = [
    ("NotoSansSC", "NotoSansSC-Regular.woff2"),
    ("NotoSerifSC", "NotoSerifSC-Regular.woff2"),
    ("LXGWWenKai", "LXGWWenKai-Regular.woff2"),
]

# Unicode ranges per slot. Keep these in lockstep with the @font-face rules
# in src/index.css.
SLOTS: dict[str, str] = {
    # Basic Latin, Latin-1 Supplement, Latin Extended-A, general punctuation,
    # CJK punctuation & fullwidth forms, common spacing.
    "latin": "U+0020-00FF,U+2000-206F,U+2E80-2EFF,U+3000-303F,U+FF00-FFEF",
    # Unified CJK Ideographs: covers ~99% of the game's text body.
    "common": "U+4E00-9FFF",
    # Ext A (U+3400-4DBF) + Ext B (U+20000-2A6DF) for rare chars.
    "ext": "U+3400-4DBF,U+20000-2A6DF",
}


def make_subsetter(unicode_ranges: str) -> Subsetter:
    options = Options()
    options.flavor = "woff2"
    # Keep the fonts light: drop hinting, vertical metrics, fancy layout.
    options.desubroutinize = True
    options.hinting = False
    options.drop_tables += ["GPOS", "GSUB", "BASE", "vhea", "vmtx", "vmrg", "MATH"]
    # Drop all OpenType layout features — our reader doesn't need them.
    options.layout_features = []
    options.name_IDs = []
    options.glyph_names = False
    options.recommended_glyphs = True
    options.ignore_missing_glyphs = True
    options.ignore_missing_unicodes = True
    # Large CJK fonts — disable the slow closure pass.
    options.layout_closure = False
    sub = Subsetter(options=options)
    sub.populate(unicodes=parse_ranges(unicode_ranges))
    return sub


def parse_ranges(spec: str) -> list[int]:
    """Expand an `U+xxxx-yyyy,U+zzzz` spec into a flat list of codepoints."""
    codepoints: list[int] = []
    for part in spec.split(","):
        part = part.strip().upper()
        if part.startswith("U+"):
            part = part[2:]
        if "-" in part:
            start, end = part.split("-", 1)
            codepoints.extend(range(int(start, 16), int(end, 16) + 1))
        else:
            codepoints.append(int(part, 16))
    return codepoints


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    opts = Options()
    opts.flavor = "woff2"

    for family, filename in FAMILIES:
        src = SRC_DIR / filename
        if not src.exists():
            sys.stderr.write(f"[warn] skipping missing font: {src}\n")
            continue
        src_size_mb = src.stat().st_size / (1024 * 1024)
        print(f"{family}: source = {src_size_mb:.1f} MB")

        for slot, ranges in SLOTS.items():
            font = load_font(str(src), opts, lazy=False)
            sub = make_subsetter(ranges)
            sub.subset(font)
            out_path = OUT_DIR / f"{family}-{slot}.woff2"
            save_font(font, str(out_path), opts)
            out_size_kb = out_path.stat().st_size / 1024
            print(f"  → {out_path.name} ({out_size_kb:.0f} KB)")
            font.close()

    print("\nDone. Update src/index.css to reference the new shards.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
