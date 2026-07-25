import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Antes deste arquivo o vitest rodava com o ambiente node padrão, então não
 * existia um único teste que montasse um componente. As três fases anteriores
 * da migração web perderam três bugs de forma-de-resposta que um render teria
 * pegado; jsdom é a compensação estrutural para isso.
 *
 * O alias para @obsidiankan/types aponta para o fonte, não para o dist, para
 * um teste não passar contra um build velho. Mesmo padrão do vitest.config.ts
 * do server — mas sem `extensionAlias`, que é opção do Rollup e não do Vite: o
 * resolver do Vite já mapeia os imports `.js` para `.ts` num projeto TS.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
  },
  resolve: {
    alias: { '@obsidiankan/types': new URL('../shared/src/index.ts', import.meta.url).pathname },
  },
})
