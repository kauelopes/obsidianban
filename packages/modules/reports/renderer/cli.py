#!/usr/bin/env python3
"""Entrada do renderer: lê {document, theme} em JSON pelo stdin e grava o PDF.

Uso (pelo servidor): python cli.py --out /caminho/report.pdf < spec.json
Saída 0 = PDF gravado; qualquer erro sai no stderr com código != 0.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from obsidiankan_pdf.compilar import compilar, montar_html  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="caminho do PDF de saída")
    ap.add_argument("--html", action="store_true", help="grava o HTML intermediário ao lado (depuração)")
    args = ap.parse_args()

    spec = json.load(sys.stdin)
    doc, tema = spec["document"], spec.get("theme") or {}
    destino = Path(args.out)
    if args.html:
        destino.with_suffix(".html").write_text(montar_html(doc, tema), encoding="utf-8")
    compilar(doc, tema, destino)
    return 0


if __name__ == "__main__":
    sys.exit(main())
