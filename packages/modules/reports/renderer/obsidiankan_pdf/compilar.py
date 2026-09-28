"""Montagem do documento (capa + seções + notas) e compilação para PDF.

Adaptado de geracao_reports/core/compilar.py. Lá o contrato era um dataclass
`Report` montado por um módulo Python; aqui o contrato é o ReportDocument que
o servidor Node manda em JSON — a mesma estrutura que gera o Markdown.
"""

from __future__ import annotations

from pathlib import Path

from weasyprint import HTML

from . import brand as b
from . import estilo
from . import paginas as p
from .blocos import bloco, data_br


def periodo_br(periodo: dict) -> str:
    de, ate = data_br(periodo["from"]), data_br(periodo["to"])
    return de if de == ate else f"{de} a {ate}"


def montar_html(doc: dict, tema: dict | None) -> str:
    b.aplicar_tema(tema)
    capa = p.capa(doc["kicker"], doc["title"], doc["subtitle"], periodo_br(doc["period"]),
                  data_br(doc["generated_at"]))
    secoes = [
        p.secao(s["title"], s.get("lead") or "", "\n".join(bloco(x) for x in s["blocks"]))
        for s in doc["sections"]
    ]
    if doc.get("notes"):
        secoes.append(p.secao("Notas metodológicas", "Como os números deste relatório foram calculados.",
                              p.notas(doc["notes"]), nova_pagina=True))
    return f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>{p.e(doc["title"])}</title>
<style>{estilo.css_base()}</style></head>
<body>
{capa}
{"".join(secoes)}
{p.contato()}
</body></html>"""


def compilar(doc: dict, tema: dict | None, destino: Path) -> Path:
    html = montar_html(doc, tema)
    destino.parent.mkdir(parents=True, exist_ok=True)
    tmp = destino.with_suffix(destino.suffix + ".tmp")
    HTML(string=html, base_url=str(b.RAIZ)).write_pdf(tmp)
    tmp.replace(destino)  # atômico: o servidor nunca lê um PDF pela metade
    return destino
