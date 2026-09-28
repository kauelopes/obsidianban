"""CSS do relatório A4: @font-face, @page, capa, miolo e componentes.

Adaptado de geracao_reports/core/estilo.py (css_base): mesma gramática de
página — capa escura com a massa de texto ancorada embaixo, uma seção por
página, KPIs em régua, tabelas monoespaçadas — com a paleta do ObsidianKan.
"""

from . import brand as b


def _font_faces() -> str:
    faces = []
    for familia, arquivo, peso in b.FONTES:
        url = (b.ASSETS / "fonts" / arquivo).as_uri()
        faces.append(
            f"@font-face {{ font-family: '{familia}'; font-weight: {peso}; "
            f"src: url('{url}') format('truetype'); }}"
        )
    return "\n".join(faces)


def _css_str(s: str) -> str:
    """Texto do usuário dentro de uma string CSS (content: "...")."""
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def css_base() -> str:
    return f"""
{_font_faces()}

@page {{
    size: A4;
    margin: 22mm 18mm 20mm 18mm;
    @bottom-left {{ content: "{_css_str(b.RODAPE_PAGINA)}"; font-family: {b.SANS}; font-size: 7.5pt; color: {b.MUTED}; }}
    @bottom-right {{ content: counter(page); font-family: {b.MONO}; font-size: 7.5pt; color: {b.MUTED}; }}
}}
@page cheia {{ margin: 0; @bottom-left {{ content: none }} @bottom-right {{ content: none }} }}

* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ font-family: {b.SANS}; color: {b.INK}; font-size: 10pt; line-height: 1.62; }}
a {{ color: inherit; text-decoration: none; }}
b, strong {{ font-weight: 600; }}

/* ------------------------------------------------------------- capa */
.capa {{
    page: cheia;
    height: 297mm;
    background: {b.ESCURO};
    color: {b.CLARO};
    padding: 26mm 24mm 22mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    page-break-after: always;
}}
.capa .filete {{ width: 18mm; height: 0.8mm; background: {b.ACCENT}; margin: 0 0 9mm; }}
.capa .kicker {{ font-family: {b.MONO}; font-size: 8pt; letter-spacing: 0.22em;
    text-transform: uppercase; color: {b.ACCENT}; margin-bottom: 6mm; }}
.capa h1 {{ font-family: {b.DISPLAY}; font-weight: 300; font-size: 38pt;
    line-height: 1.08; letter-spacing: -0.025em; }}
.capa .sub {{ margin-top: 8mm; font-size: 11.5pt; line-height: 1.6;
    color: {b.CLARO}; opacity: 0.68; max-width: 132mm; }}
.capa .periodo {{ margin-top: 6mm; font-family: {b.MONO}; font-size: 9pt;
    letter-spacing: 0.06em; color: {b.ACCENT_LIGHT}; }}
.capa .centro {{ padding-bottom: 16mm; }}
.capa .meta {{ padding-top: 4mm; border-top: 0.5pt solid rgba(238,242,244,0.22);
    font-size: 7.5pt; color: {b.CLARO}; opacity: 0.5; }}

/* ---------------------------------------------- masthead (páginas escuras) */
.cabecalho .lockup {{ font-family: {b.DISPLAY}; font-weight: 600; font-size: 15pt;
    letter-spacing: -0.01em; }}
.cabecalho .regua {{ display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 4mm; padding-top: 2.5mm; border-top: 0.5pt solid rgba(75,179,196,0.4); }}
.cabecalho .linha {{ font-family: {b.MONO}; font-size: 6.5pt; letter-spacing: 0.2em;
    text-transform: uppercase; color: {b.CLARO}; opacity: 0.45; }}
.cabecalho .edicao {{ font-family: {b.MONO}; font-size: 6.5pt; letter-spacing: 0.2em;
    text-transform: uppercase; color: {b.ACCENT}; }}

/* ------------------------------------------------------------ miolo */
h2 {{ font-family: {b.DISPLAY}; font-size: 18pt; font-weight: 400; color: {b.INK}; letter-spacing: -0.01em; }}
h3 {{ font-family: {b.DISPLAY}; font-size: 12pt; font-weight: 500; color: {b.INK}; margin-top: 6mm; }}
.rule {{ width: 30mm; height: 1mm; background: {b.ACCENT_DARK}; margin: 3mm 0 6mm; }}
p.lead {{ color: {b.MUTED}; font-size: 10pt; max-width: 150mm; }}
p.analise {{ margin-top: 6mm; font-size: 9.5pt; max-width: 158mm; }}
p.lead, p.analise, .destaque p {{ text-align: justify; }}
/* Diferente da referência (uma seção por página, peça editorial): relatório
   de dados tem seção curta, então o miolo flui e só o título não fica órfão. */
section {{ margin-top: 13mm; }}
section:first-of-type {{ margin-top: 0; }}
section h2 {{ page-break-after: avoid; }}
section .rule, section p.lead {{ page-break-after: avoid; }}
section.nova-pagina {{ page-break-before: always; margin-top: 0; }}

/* --------------------------------------------------------- figuras */
.grafico {{ margin: 8mm 0 2mm; text-align: center; page-break-inside: avoid; }}
.grafico svg {{ width: 158mm; height: auto; }}
.grafico .titulo {{ font-family: {b.MONO}; font-size: 7.5pt; letter-spacing: 0.08em;
    text-transform: uppercase; color: {b.MUTED}; margin-bottom: 2mm; text-align: left; }}

.legenda {{ text-align: center; font-family: {b.SANS}; font-size: 8pt; color: {b.MUTED}; }}
.legenda .sw {{ margin: 0 2.5mm; white-space: nowrap; }}
.legenda i {{ display: inline-block; width: 9pt; height: 6pt; margin-right: 2pt; vertical-align: -1pt; border: 0.3pt solid {b.LINHA}; }}

/* ------------------------------------------------------ componentes */
.kpis {{ display: flex; margin-top: 7mm; border-top: 0.5pt solid {b.LINHA}; page-break-inside: avoid; }}
.kpi {{ flex: 1; padding: 4mm 3mm 0; }}
.kpi .v {{ font-family: {b.DISPLAY}; font-weight: 500; font-size: 17pt; color: {b.ACCENT_DARK}; line-height: 1.2; }}
.kpi .l {{ font-family: {b.MONO}; font-size: 7pt; letter-spacing: 0.06em; text-transform: uppercase; color: {b.MUTED}; }}
.kpi .h {{ font-size: 7.5pt; color: {b.MUTED}; margin-top: 1mm; }}

.destaque {{ margin: 7mm 0 2mm; padding: 5mm 6mm; background: {b.PAPEL_DESTAQUE};
             border-left: 1mm solid {b.ACCENT_DARK}; page-break-inside: avoid; }}
.destaque .titulo {{ font-family: {b.MONO}; font-size: 7.5pt; letter-spacing: 0.12em;
             text-transform: uppercase; color: {b.ACCENT_DARK}; margin-bottom: 2mm; }}
.destaque p {{ font-size: 9.5pt; }}
.destaque.alerta {{ border-left-color: {b.SEGUNDA}; background: #fbf6ec; }}
.destaque.alerta .titulo {{ color: {b.SEGUNDA_DARK}; }}

.tabela-bloco {{ margin: 7mm 0 2mm; }}
.tabela-bloco.curta {{ page-break-inside: avoid; }}
.tabela-titulo {{ font-family: {b.MONO}; font-size: 7.5pt; letter-spacing: 0.08em;
    text-transform: uppercase; color: {b.MUTED}; padding-bottom: 2mm; page-break-after: avoid; }}
table.tabela {{ width: 100%; border-collapse: collapse; font-size: 9pt; }}
table.tabela th {{ font-family: {b.MONO}; font-size: 7pt; letter-spacing: 0.06em;
    text-transform: uppercase; color: {b.MUTED}; text-align: left; font-weight: 500;
    border-bottom: 0.6pt solid {b.INK}; padding: 0 3mm 2mm 0; }}
table.tabela td {{ padding: 2.2mm 3mm 2.2mm 0; border-bottom: 0.3pt solid {b.LINHA}; vertical-align: top; }}
table.tabela td.num, table.tabela th.num {{ text-align: right; font-family: {b.MONO};
    font-variant-numeric: tabular-nums; padding-right: 0; padding-left: 3mm; }}
table.tabela td.num {{ white-space: nowrap; }}
table.tabela th + th, table.tabela td + td {{ padding-left: 3mm; }}
table.tabela tr {{ page-break-inside: avoid; }}
table.tabela tr:last-child td {{ border-bottom: none; }}

ul.lista {{ margin: 5mm 0 2mm 5mm; font-size: 9.5pt; }}
ul.lista li {{ margin-top: 1.5mm; }}

.vazio {{ margin-top: 6mm; font-size: 9.5pt; color: {b.MUTED}; font-style: italic; }}

/* ------------------------------------------------------ análise por IA */
.analise-ia {{ margin-top: 7mm; padding: 5mm 6mm; border: 0.5pt solid {b.LINHA};
    border-left: 1mm solid {b.SEGUNDA}; }}
.analise-ia .rot {{ font-family: {b.MONO}; font-size: 6.5pt; letter-spacing: 0.2em;
    text-transform: uppercase; color: {b.SEGUNDA_DARK}; }}
.analise-ia .aviso {{ margin-top: 1.5mm; font-size: 7.5pt; color: {b.MUTED}; }}
.analise-ia h3 {{ font-size: 11pt; margin-top: 5mm; }}
.analise-ia p {{ margin-top: 2mm; font-size: 9.5pt; text-align: justify; }}
.analise-ia ul {{ margin: 2mm 0 0 5mm; font-size: 9.5pt; }}
.analise-ia li {{ margin-top: 1.2mm; }}

/* ------------------------------------------------------------- notas */
.notas {{ margin-top: 6mm; font-size: 8.5pt; color: {b.MUTED}; }}
.notas li {{ margin: 2mm 0 0 5mm; }}

/* ------------------------------------------------------- quarta capa */
.escura {{
    page: cheia;
    height: 297mm;
    background: {b.ESCURO};
    color: {b.CLARO};
    position: relative;
    page-break-before: always;
}}
.contato {{ padding: 26mm 24mm 22mm; display: flex; flex-direction: column;
    justify-content: space-between; }}
.contato .vias {{ margin-top: 12mm; }}
.contato .via {{ display: flex; align-items: baseline; gap: 6mm; padding: 4.5mm 0;
    border-top: 0.5pt solid rgba(238,242,244,0.18); max-width: 152mm; }}
.contato .via:last-child {{ border-bottom: 0.5pt solid rgba(238,242,244,0.18); }}
.contato .via .rot {{ width: 34mm; flex: none; font-family: {b.MONO}; font-size: 7pt;
    letter-spacing: 0.14em; text-transform: uppercase; color: {b.ACCENT}; }}
.contato .via .val {{ font-family: {b.DISPLAY}; font-weight: 400; font-size: 13pt; color: {b.CLARO}; }}
"""
