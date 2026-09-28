"""Gráficos matplotlib no estilo da casa, sempre com saída em SVG inline.

Adaptado de geracao_reports/core/figuras.py (barras, linhas, estilo_eixos,
fig_para_svg). Regras mantidas: nenhuma cor literal aqui — tudo vem de
`brand`; gráficos transparentes (o fundo é o papel) e sem moldura; texto
como texto no SVG, com as mesmas fontes do documento.
"""

from __future__ import annotations

import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.ticker import MaxNLocator  # noqa: E402

from . import brand as b  # noqa: E402

for _familia, _arquivo, _peso in b.FONTES:
    font_manager.fontManager.addfont(str(b.ASSETS / "fonts" / _arquivo))
plt.rcParams.update({
    "font.family": "Inter",
    "font.size": 8,
    "svg.fonttype": "none",  # mantém o texto como texto no SVG (leve e nítido)
})


def estilo_eixos(ax, grade: str = "y") -> None:
    """Tira molduras e aplica a grade discreta da casa."""
    for lado in ("top", "right", "left" if grade == "y" else "bottom"):
        ax.spines[lado].set_visible(False)
    eixo_visivel = "bottom" if grade == "y" else "left"
    ax.spines[eixo_visivel].set_color(b.LINHA)
    ax.spines[eixo_visivel].set_linewidth(0.8)
    ax.grid(axis=grade, color=b.LINHA, linewidth=0.6, alpha=0.9)
    ax.set_axisbelow(True)
    ax.tick_params(colors=b.MUTED, labelsize=8, length=0)
    for rotulo in ax.get_xticklabels() + ax.get_yticklabels():
        rotulo.set_color(b.MUTED)


def fig_para_svg(fig) -> str:
    buf = io.StringIO()
    fig.savefig(buf, format="svg", bbox_inches="tight", transparent=True)
    plt.close(fig)
    svg = buf.getvalue()
    # o cabeçalho XML/DOCTYPE não pode ir no meio do HTML
    return svg[svg.find("<svg"):]


def cores(n: int) -> list[str]:
    """n cores categóricas da paleta (cicla se precisar de mais)."""
    return [b.SERIES[i % len(b.SERIES)] for i in range(n)]


def _fmt(v: float, unidade: str) -> str:
    txt = f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}"
    return txt.replace(",", "X").replace(".", ",").replace("X", ".") + unidade


def _rotulos_x(ax, rotulos: list[str]) -> None:
    """Muitos pontos no eixo x: mostra um a cada N para não encavalar."""
    passo = max(1, len(rotulos) // 12)
    ax.set_xticks(range(len(rotulos)))
    ax.set_xticklabels([r if i % passo == 0 else "" for i, r in enumerate(rotulos)],
                       rotation=0 if len(rotulos) <= 8 else 45,
                       ha="center" if len(rotulos) <= 8 else "right")


def barras(rotulos: list[str], valores: list[float], cor: str = b.ACCENT_MID,
           horizontal: bool = True, unidade: str = "",
           figsize: tuple[float, float] = (7.4, 4.2)) -> str:
    """Barras com rótulo de valor na ponta (padrão: horizontais, maior no topo)."""
    topo = max(valores) or 1
    if horizontal:
        figsize = (figsize[0], max(1.6, 0.34 * len(rotulos) + 0.8))
    fig, ax = plt.subplots(figsize=figsize)
    if horizontal:
        pos = list(range(len(rotulos)))
        ax.barh(pos, valores, color=cor, height=0.62)
        ax.set_yticks(pos, rotulos, fontsize=8)
        ax.invert_yaxis()
        estilo_eixos(ax, grade="x")
        for y, v in zip(pos, valores):
            ax.text(v + topo * 0.015, y, _fmt(v, unidade), va="center", fontsize=7.5,
                    color=b.INK, fontweight="medium")
        ax.set_xlim(0, topo * 1.18)
    else:
        pos = list(range(len(rotulos)))
        ax.bar(pos, valores, color=cor, width=0.62)
        estilo_eixos(ax, grade="y")
        _rotulos_x(ax, rotulos)
        if len(rotulos) <= 16:
            for x, v in zip(pos, valores):
                ax.text(x, v + topo * 0.02, _fmt(v, unidade), ha="center", fontsize=7, color=b.INK)
        ax.set_ylim(0, topo * 1.16)
        _eixo_inteiro(ax, valores)
    return fig_para_svg(fig)


def barras_agrupadas(rotulos: list[str], series: dict[str, list[float]],
                     figsize: tuple[float, float] = (7.4, 3.8)) -> str:
    """Várias séries lado a lado por categoria (ex.: entregas e custo por semana)."""
    fig, ax = plt.subplots(figsize=figsize)
    n = len(series)
    largura = 0.8 / max(n, 1)
    for i, ((nome, ys), cor) in enumerate(zip(series.items(), cores(n))):
        ax.bar([x + (i - (n - 1) / 2) * largura for x in range(len(rotulos))], ys,
               width=largura, color=cor, label=nome)
    estilo_eixos(ax, grade="y")
    _rotulos_x(ax, rotulos)
    _eixo_inteiro(ax, [v for ys in series.values() for v in ys])
    return fig_para_svg(fig)


def _eixo_inteiro(ax, valores: list[float]) -> None:
    """Contagem (cards, entregas) não tem meio: sem 0,5 no eixo."""
    if all(float(v).is_integer() for v in valores):
        ax.yaxis.set_major_locator(MaxNLocator(integer=True))


def linhas(x: list[str], series: dict[str, list[float]],
           figsize: tuple[float, float] = (7.4, 3.8)) -> str:
    """Uma linha por série. Série única é rotulada na ponta; várias usam a
    legenda de paginas.legenda — rótulos na ponta encavalam quando as séries
    terminam no mesmo valor (burn-up concluído = escopo)."""
    fig, ax = plt.subplots(figsize=figsize)
    pos = list(range(len(x)))
    marcador = "o" if len(x) <= 30 else None
    for (nome, ys), cor in zip(series.items(), cores(len(series))):
        ax.plot(pos, ys, color=cor, linewidth=1.8, marker=marcador, markersize=3.2)
        if len(series) == 1:
            ax.annotate(f" {nome}", (pos[-1], ys[-1]), color=cor, fontsize=8,
                        va="center", fontweight="medium")
    estilo_eixos(ax, grade="y")
    _rotulos_x(ax, x)
    _eixo_inteiro(ax, [v for ys in series.values() for v in ys])
    ax.set_ylim(bottom=0, top=max(v for ys in series.values() for v in ys) * 1.12)
    ax.margins(x=0.02)
    if len(series) == 1:
        # espaço à direita para o rótulo da série não ser cortado
        ax.set_xlim(right=ax.get_xlim()[1] + max(1, (len(x) - 1)) * 0.28)
    return fig_para_svg(fig)
