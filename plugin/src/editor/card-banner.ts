import { MarkdownView, type Plugin, TFile } from 'obsidian'

const BANNER_CLASS = 'kanban-mcp-card-banner'
const VIEW_CLASS = 'kanban-mcp-card-view'
const BANNER_TEXT = 'Managed card — edit body freely. Frontmatter fields are auto-managed by the MCP.'

function isCardFile(file: TFile): boolean {
  return file.extension === 'md' && file.name.startsWith('card-')
}

function clearStaleDecorations(): void {
  document.querySelectorAll('.' + BANNER_CLASS).forEach((el) => el.remove())
  // MarkdownView instances are reused for different files — strip the
  // card class so non-card files don't inherit the property-widget hide.
  document.querySelectorAll('.' + VIEW_CLASS).forEach((el) => el.classList.remove(VIEW_CLASS))
}

function decorate(view: MarkdownView): void {
  const container = view.contentEl
  container.addClass(VIEW_CLASS)
  if (container.querySelector('.' + BANNER_CLASS)) return
  const banner = document.createElement('div')
  banner.className = BANNER_CLASS
  banner.textContent = BANNER_TEXT
  container.prepend(banner)
}

/**
 * Registers a workspace listener that decorates opened card files:
 * adds an advisory banner above the editor and a class on the view
 * container that the stylesheet uses to hide the (otherwise long)
 * Properties widget.
 */
export function registerCardBanner(plugin: Plugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('file-open', (file) => {
      clearStaleDecorations()
      if (!file || !isCardFile(file)) return
      const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
      if (view) decorate(view)
    }),
  )
}
