import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev the SPA runs on its own port, so /mcp and /events are proxied to the
// kanban server. In production the server serves dist/ from the same origin
// and no proxy exists — which is why every request path here is relative.
const KANBAN = process.env['KANBAN_URL'] ?? 'http://127.0.0.1:9375'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      '/mcp': { target: KANBAN, changeOrigin: false },
      '/events': { target: KANBAN, changeOrigin: false },
      '/health': { target: KANBAN, changeOrigin: false },
      '/metrics': { target: KANBAN, changeOrigin: false },
    },
  },
  // @obsidiankan/types compiles to CommonJS because the server (which also
  // consumes it) is CJS. Rollup only applies the commonjs interop to
  // node_modules by default, and a workspace link is not that — so the shared
  // package has to be named explicitly or its runtime exports (parseSections)
  // resolve to nothing.
  optimizeDeps: { include: ['@obsidiankan/types'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    commonjsOptions: { include: [/node_modules/, /packages\/shared/] },
  },
})
