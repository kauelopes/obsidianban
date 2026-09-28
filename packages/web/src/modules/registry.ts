import type { WebModule } from '@obsidiankan/module-sdk/web'
import { reportsWebModule } from '@obsidiankan/module-reports/web'

/**
 * Parte web dos módulos instalados — espelho do registry do servidor. É o
 * ÚNICO ponto do web que importa código de módulo. Um módulo só aparece na
 * interface quando está aqui E ativo no servidor (GET /modules).
 */
export const INSTALLED_WEB_MODULES: readonly WebModule[] = [reportsWebModule]
