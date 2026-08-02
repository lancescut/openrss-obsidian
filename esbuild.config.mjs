import esbuild from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

await esbuild.build({
  entryPoints: [resolve(root, 'src', 'main.ts')],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/state',
    '@codemirror/view',
    '@codemirror/language',
    '@lezer/common',
    '@lezer/highlight',
  ],
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  outfile: resolve(root, 'main.js'),
  minify: true,
  sourcemap: false,
  logLevel: 'info',
})
