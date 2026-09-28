import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Server roda em node, web em jsdom (anotado no topo de cada teste web). Os
// aliases apontam para o fonte, como nos outros pacotes: teste nunca roda
// contra um dist velho.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    restoreMocks: true,
    // Datas "de gente" (hoje, gerado em, dia da sprint) saem no fuso local;
    // fixar o fuso deixa os testes iguais em qualquer máquina.
    env: { TZ: 'America/Sao_Paulo' },
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@obsidiankan/types': path.resolve(__dirname, '../../shared/src/index.ts'),
      '@obsidiankan/module-sdk/web': path.resolve(__dirname, '../../module-sdk/web/index.ts'),
      '@obsidiankan/module-sdk': path.resolve(__dirname, '../../module-sdk/src/index.ts'),
    },
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
})
