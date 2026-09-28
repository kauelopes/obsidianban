import type { ServerModule } from '@obsidiankan/module-sdk'
import { reportsModule } from '@obsidiankan/module-reports'

/**
 * Módulos instalados. Este é o ÚNICO ponto do core que importa código de
 * módulo: desinstalar = tirar a linha daqui (e o pacote do workspace).
 * Ativar/desativar não passa por aqui — é o toggle em Configs → Módulos.
 */
export const INSTALLED_MODULES: readonly ServerModule[] = [reportsModule]
