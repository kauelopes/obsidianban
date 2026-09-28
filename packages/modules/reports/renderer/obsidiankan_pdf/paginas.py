"""Páginas e componentes HTML: capa, seção, KPIs, tabela, destaque, figura.

Adaptado de geracao_reports/core/paginas.py. Diferença de fundo: lá o texto
era escrito à mão no próprio módulo do report; aqui vem do vault (título de
card, nome de sprint), então todo componente recebe TEXTO e escapa — só
`figura` (SVG do matplotlib) e `html_confiavel` recebem markup pronto.
"""

from __future__ import annotations

from html import escape

from . import brand as b


def e(s: object) -> str:
    return escape(str(s), quote=True)


# ------------------------------------------------------------- páginas
def capa(kicker: str, titulo: str, subtitulo: str, periodo: str, gerado_em: str) -> str:
    """Capa escura: masthead no topo, a massa de texto ancorada embaixo."""
    site = f" · {e(b.SITE)}" if b.SITE else ""
    return f"""
<div class="capa">
    <div class="cabecalho">
        <div class="lockup">{e(b.MARCA)}</div>
        <div class="regua">
            <div class="linha">{e(b.TAGLINE)}</div>
            <div class="edicao">{e(b.TIPO_DOCUMENTO)}</div>
        </div>
    </div>
    <div class="baixo">
        <div class="centro">
            <div class="filete"></div>
            <div class="kicker">{e(kicker)}</div>
            <h1>{e(titulo)}</h1>
            <div class="sub">{e(subtitulo)}</div>
            <div class="periodo">{e(periodo)}</div>
        </div>
        <div class="meta">Gerado em {e(gerado_em)} a partir do vault{site}</div>
    </div>
</div>"""


def contato() -> str:
    """Quarta capa com os canais do tema — só entra quando há canais."""
    if not b.CONTATO:
        return ""
    linhas = []
    for rotulo, valor, link in b.CONTATO:
        val = f'<a href="{e(link)}">{e(valor)}</a>' if link else e(valor)
        linhas.append(f'<div class="via"><div class="rot">{e(rotulo)}</div><div class="val">{val}</div></div>')
    return f"""
<div class="escura contato">
    <div class="cabecalho">
        <div class="lockup">{e(b.MARCA)}</div>
        <div class="regua">
            <div class="linha">{e(b.TAGLINE)}</div>
            <div class="edicao">Contato</div>
        </div>
    </div>
    <div class="vias">{"".join(linhas)}</div>
</div>"""


def secao(titulo: str, lead: str, corpo_html: str, nova_pagina: bool = False) -> str:
    """Uma seção do miolo; `nova_pagina` força começar no topo de uma página."""
    lead_html = f'<p class="lead">{e(lead)}</p>' if lead else ""
    classe = ' class="nova-pagina"' if nova_pagina else ""
    return f"""
<section{classe}>
    <h2>{e(titulo)}</h2>
    <div class="rule"></div>
    {lead_html}
    {corpo_html}
</section>"""


# --------------------------------------------------------- componentes
def kpis(itens: list[dict]) -> str:
    """itens: [{label, value, hint?}]."""
    divs = "\n".join(
        f'<div class="kpi"><div class="v">{e(i["value"])}</div><div class="l">{e(i["label"])}</div>'
        + (f'<div class="h">{e(i["hint"])}</div>' if i.get("hint") else "")
        + "</div>"
        for i in itens
    )
    return f'<div class="kpis">{divs}</div>'


def destaque(titulo: str, texto: str, alerta: bool = False) -> str:
    cabeca = f'<div class="titulo">{e(titulo)}</div>' if titulo else ""
    classe = "destaque alerta" if alerta else "destaque"
    return f'<div class="{classe}">{cabeca}<p>{e(texto)}</p></div>'


def tabela(colunas: list[str], linhas: list[list[str]], num: set[int] | None = None,
           legenda: str = "") -> str:
    """`num`: índices de colunas alinhadas à direita (monoespaçadas)."""
    num = num or set()
    th = "".join(
        f'<th class="num">{e(c)}</th>' if i in num else f"<th>{e(c)}</th>"
        for i, c in enumerate(colunas)
    )
    trs = []
    for linha in linhas:
        tds = "".join(
            f'<td class="num">{e(v)}</td>' if i in num else f"<td>{e(v)}</td>"
            for i, v in enumerate(linha)
        )
        trs.append(f"<tr>{tds}</tr>")
    cap = f"<caption>{e(legenda)}</caption>" if legenda else ""
    # Tabela curta partida entre páginas só atrapalha; longa flui (o thead repete).
    classe = "tabela curta" if len(linhas) <= 12 else "tabela"
    return (f'<table class="{classe}">{cap}<thead><tr>{th}</tr></thead>'
            f'<tbody>{"".join(trs)}</tbody></table>')


def figura(svg: str, titulo: str = "") -> str:
    cabeca = f'<div class="titulo">{e(titulo)}</div>' if titulo else ""
    return f'<div class="grafico">{cabeca}{svg}</div>'


def legenda(itens: list[tuple[str, str]]) -> str:
    """Swatches de legenda: lista de (cor_css, rótulo)."""
    sws = "\n".join(
        f'<span class="sw"><i style="background:{cor}"></i>{e(rot)}</span>'
        for cor, rot in itens
    )
    return f'<div class="legenda">{sws}</div>'


def paragrafo(texto: str) -> str:
    return f'<p class="analise">{e(texto)}</p>'


def lista(itens: list[str]) -> str:
    return '<ul class="lista">' + "".join(f"<li>{e(i)}</li>" for i in itens) + "</ul>"


def vazio(texto: str) -> str:
    return f'<p class="vazio">{e(texto)}</p>'


def analise_ia(html_confiavel: str, fonte: str, data: str) -> str:
    """Bloco da análise por IA — sempre rotulado como interpretação."""
    return f"""
<div class="analise-ia">
    <div class="rot">Análise gerada por IA</div>
    <div class="aviso">{e(fonte)} · {e(data)} · interpretação dos números deste relatório, não dado.</div>
    {html_confiavel}
</div>"""


def notas(itens: list[str]) -> str:
    return '<ul class="notas">' + "".join(f"<li>{e(i)}</li>" for i in itens) + "</ul>"
