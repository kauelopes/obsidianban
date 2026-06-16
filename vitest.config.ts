import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/server/stdio.ts', 'src/watcher/**', 'src/auth/cli.ts'],
    },
  },
  resolve: {
    // Vitest resolves .js imports to .ts automatically for NodeNext projects
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
})
