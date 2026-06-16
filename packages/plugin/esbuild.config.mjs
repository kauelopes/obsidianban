import esbuild from 'esbuild'
import builtins from 'builtin-modules'
import { mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const watch = process.argv.includes('--watch')

// Default output: in-repo test vault. Override with OBSIDIANKAN_DEV_VAULT.
const vaultPath = process.env.OBSIDIANKAN_DEV_VAULT ?? path.join(repoRoot, 'test-vault')
const outDir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidiankan-mcp')
mkdirSync(outDir, { recursive: true })

const copyAssets = {
  name: 'copy-assets',
  setup(build) {
    build.onEnd(() => {
      copyFileSync(path.join(__dirname, 'manifest.json'), path.join(outDir, 'manifest.json'))
      copyFileSync(path.join(__dirname, 'styles.css'), path.join(outDir, 'styles.css'))
    })
  },
}

const options = {
  entryPoints: [path.join(__dirname, 'src/main.ts')],
  bundle: true,
  format: 'cjs',
  target: 'es2018',
  platform: 'node',
  logLevel: 'info',
  sourcemap: 'inline',
  outfile: path.join(outDir, 'main.js'),
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
  plugins: [copyAssets],
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log(`[esbuild] watching → ${outDir}`)
} else {
  await esbuild.build(options)
  console.log(`[esbuild] built → ${outDir}`)
}
