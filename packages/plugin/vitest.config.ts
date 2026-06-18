import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@obsidiankan/types': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
})
