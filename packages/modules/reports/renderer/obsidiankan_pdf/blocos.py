"""ReportDocument (JSON vindo do Node) → HTML do miolo.

O mesmo documento gera o Markdown da interface (server/markdown.ts); cada tipo
de bloco aqui tem o seu par lá. Se um bloco novo surgir no TypeScript e não
aqui, ele é ignorado com aviso no stderr — o PDF sai, sem o bloco.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime
from html import escape

from . import figuras
from . import paginas as p


def bloco(b: dict) -> str:
    kind = b.get("kind")
    if kind == "paragraph":
        return p.paragrafo(b["text"])
    if kind == "list":
        return p.lista(b["items"])
    if kind == "kpis":
        return p.kpis(b["items"])
    if kind == "table":
        if not b["rows"]:
            return p.vazio("sem linhas")
        return p.tabela(b["columns"], b["rows"], set(b.get("numeric") or []), b.get("caption") or "")
    if kind == "callout":
        return p.destaque(b["title"], b["text"], alerta=b.get("tone") == "warn")
    if kind == "chart":
        return grafico(b)
    if kind == "analysis":
        fonte = b["provider"] + (f" · {b['model']}" if b.get("model") else "")
        return p.analise_ia(markdown_basico(b["markdown"]), fonte, data_br(b["generated_at"]))
    print(f"renderer: bloco desconhecido {kind!r} ignorado", file=sys.stderr)
    return ""


def grafico(b: dict) -> str:
    labels: list[str] = b["labels"]
    series: list[dict] = b["series"]
    valores = [v for s in series for v in s["values"]]
    if not labels or not valores or max(valores) <= 0:
        return p.vazio(f"{b['title']}: sem dados no período.")
    unidade = b.get("unit") or ""
    if b["chart"] == "line":
        svg = figuras.linhas(labels, {s["name"]: s["values"] for s in series})
        leg = p.legenda(list(zip(figuras.cores(len(series)), [s["name"] for s in series]))) if len(series) > 1 else ""
        return p.figura(svg, b["title"]) + leg
    if len(series) == 1:
        # Categorias com nome (projetos, colunas) leem melhor na horizontal;
        # série temporal com muitos pontos, na vertical.
        horizontal = len(labels) <= 12 and max(len(x) for x in labels) > 5
        svg = figuras.barras(labels, series[0]["values"], horizontal=horizontal, unidade=unidade)
        return p.figura(svg, b["title"])
    svg = figuras.barras_agrupadas(labels, {s["name"]: s["values"] for s in series})
    leg = p.legenda(list(zip(figuras.cores(len(series)), [s["name"] for s in series])))
    return p.figura(svg, b["title"]) + leg


def data_br(iso: str) -> str:
    """dd/mm/aaaa; timestamp ISO (UTC) vira o dia no fuso local da máquina."""
    if len(iso) > 10:
        iso = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().date().isoformat()
    y, m, d = iso[:10].split("-")
    return f"{d}/{m}/{y}"


# ---------------------------------------------------------- markdown mínimo
# A análise do LLM é Markdown curto e previsível (### seções, bullets, negrito).
# Conversor próprio em vez de uma lib: tudo é escapado ANTES, então HTML que o
# modelo devolva vira texto — nada de markup cru dentro do PDF.
_INLINE = [
    (re.compile(r"\*\*(.+?)\*\*"), r"<strong>\1</strong>"),
    (re.compile(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])"), r"<em>\1</em>"),
    (re.compile(r"(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])"), r"<em>\1</em>"),
    (re.compile(r"`([^`]+)`"), r"<code>\1</code>"),
]


def _inline(texto: str) -> str:
    out = escape(texto, quote=False)
    for rx, rep in _INLINE:
        out = rx.sub(rep, out)
    return out


def markdown_basico(md: str) -> str:
    html: list[str] = []
    paragrafo: list[str] = []
    lista: list[str] = []
    ordenada = False

    def fecha_paragrafo() -> None:
        if paragrafo:
            html.append(f"<p>{_inline(' '.join(paragrafo))}</p>")
            paragrafo.clear()

    def fecha_lista() -> None:
        nonlocal ordenada
        if lista:
            tag = "ol" if ordenada else "ul"
            html.append(f"<{tag}>" + "".join(f"<li>{_inline(i)}</li>" for i in lista) + f"</{tag}>")
            lista.clear()

    for linha in md.splitlines():
        s = linha.strip()
        titulo = re.match(r"^(#{1,6})\s+(.*)$", s)
        item = re.match(r"^[-*+]\s+(.*)$", s)
        num = re.match(r"^\d+[.)]\s+(.*)$", s)
        if not s:
            fecha_paragrafo()
            fecha_lista()
        elif titulo:
            fecha_paragrafo()
            fecha_lista()
            html.append(f"<h3>{_inline(titulo.group(2))}</h3>")
        elif item or num:
            fecha_paragrafo()
            if lista and ordenada != bool(num):
                fecha_lista()
            ordenada = bool(num)
            lista.append((item or num).group(1))
        elif lista and linha.startswith((" ", "\t")):
            lista[-1] += " " + s  # continuação do item
        else:
            fecha_lista()
            paragrafo.append(s)
    fecha_paragrafo()
    fecha_lista()
    return "\n".join(html)
