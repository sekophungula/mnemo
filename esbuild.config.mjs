import esbuild from 'esbuild'
import builtins from 'builtin-modules'

const prod = process.argv[2] === 'production'

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtins],
  format: 'cjs',
  target: 'es2018',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  logLevel: 'info',
})

if (prod) {
  await ctx.rebuild()
  process.exit(0)
} else {
  await ctx.watch()
}
