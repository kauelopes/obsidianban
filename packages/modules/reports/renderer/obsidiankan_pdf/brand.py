"""Identidade visual dos relatórios do ObsidianKan.

Adaptado de geracao_reports/core/brand.py: mesmo papel (o ÚNICO lugar com
cores, fontes e textos de marca), com a paleta do ObsidianKan e os textos de
marca configuráveis por tema (Configs → Módulos → Relatórios). As páginas
institucionais da agência (quem somos, oferta) não vieram: a de contato fica
disponível e só entra quando o tema declara canais.
"""

from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent  # renderer/
ASSETS = RAIZ / "assets"

# --------------------------------------------------------------- paleta
# Derivada dos tokens da interface (packages/web/src/styles/tokens.css):
# o PDF é impresso em papel branco, então o acento escuro (teal do tema
# claro) carrega texto e o acento claro (teal do tema escuro) vai na capa.
ESCURO = "#12181f"          # fundo das páginas cheias (capa, contato)
ESCURO_PAINEL = "#1b232c"
ACCENT = "#4bb3c4"          # acento sobre fundo escuro
ACCENT_LIGHT = "#8fd3de"
ACCENT_MID = "#2a93a5"      # preenchimento de barras/áreas no papel
ACCENT_DARK = "#0f7d8e"     # acento sobre o papel (contraste)
SEGUNDA = "#d99a2b"         # âmbar — segunda série, alertas
SEGUNDA_DARK = "#9a6a10"
OK = "#35704a"
ALERTA = "#b4442a"
CLARO = "#eef2f4"           # texto claro sobre o escuro
INK = "#0f172a"             # texto no miolo
MUTED = "#475569"
LINHA = "#dcdad3"           # filetes e bordas no miolo
PAPER = "#ffffff"
PAPEL_DESTAQUE = "#f3f7f8"  # fundo de caixas de destaque no miolo

# Sequência categórica para gráficos de várias séries.
SERIES = [ACCENT_MID, SEGUNDA, "#58a06d", "#7a8794", ACCENT, ALERTA]

# ----------------------------------------------------------- tipografia
# TTFs locais em assets/fonts (licença OFL) — o PDF compila offline.
DISPLAY = "Outfit, 'Segoe UI', Helvetica, sans-serif"   # títulos e capa
SANS = "Inter, Helvetica, Arial, sans-serif"            # corpo e rótulos
MONO = "'JetBrains Mono', ui-monospace, monospace"      # números e kickers

FONTES = [
    ("Outfit", "Outfit-300.ttf", 300),
    ("Outfit", "Outfit-400.ttf", 400),
    ("Outfit", "Outfit-500.ttf", 500),
    ("Outfit", "Outfit-600.ttf", 600),
    ("Outfit", "Outfit-700.ttf", 700),
    ("Inter", "Inter-400.ttf", 400),
    ("Inter", "Inter-500.ttf", 500),
    ("Inter", "Inter-600.ttf", 600),
    ("Inter", "Inter-700.ttf", 700),
    ("JetBrains Mono", "JetBrainsMono-500.ttf", 500),
]

# ------------------------------------------------------ textos de marca
# Padrões — sobrescritos por aplicar_tema() a cada compilação.
PADRAO = {
    "brand": "ObsidianKan",
    "tagline": "Kanban de projetos com agentes",
    "site": "",
    "footer": "ObsidianKan · relatório gerado a partir do vault",
    "document_type": "Relatório de projeto",
}

MARCA = PADRAO["brand"]
TAGLINE = PADRAO["tagline"]
SITE = PADRAO["site"]
RODAPE_PAGINA = PADRAO["footer"]
TIPO_DOCUMENTO = PADRAO["document_type"]
# Canais da quarta capa: lista de (rótulo, valor, link ou ""). Vazio = sem página.
CONTATO: list[tuple[str, str, str]] = []


def aplicar_tema(tema: dict | None) -> None:
    """Aplica os textos de marca do tema (campos ausentes voltam ao padrão)."""
    global MARCA, TAGLINE, SITE, RODAPE_PAGINA, TIPO_DOCUMENTO, CONTATO
    t = {**PADRAO, **{k: v for k, v in (tema or {}).items() if isinstance(v, str) and v.strip()}}
    MARCA = t["brand"]
    TAGLINE = t["tagline"]
    SITE = t["site"]
    RODAPE_PAGINA = t["footer"]
    TIPO_DOCUMENTO = t["document_type"]
    contato = (tema or {}).get("contact")
    CONTATO = [
        (str(c.get("label", "")), str(c.get("value", "")), str(c.get("link", "")))
        for c in contato
        if isinstance(c, dict) and c.get("label") and c.get("value")
    ] if isinstance(contato, list) else []
