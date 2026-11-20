import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const hostRoot = resolve(process.env.DSH_HOST_SOURCE ?? '../deepseek-harness')
const hostConfig = resolve(hostRoot, 'tsconfig.base.json')
// Resolve the source-engine suite through the Host's own workspace paths.
const paths: Record<string, readonly string[]> = existsSync(hostConfig)
  ? ts.readConfigFile(hostConfig, ts.sys.readFile).config.compilerOptions.paths
  : {}

export default defineConfig({
  plugins: [{
    name: 'dsh-host-source-paths',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!importer?.startsWith(`${hostRoot}/`) || !Object.hasOwn(paths, id)) return null
      const target = paths[id]?.[0]
      return target === undefined ? null : this.resolve(resolve(hostRoot, target), importer, { skipSelf: true })
    },
  }],
  server: { fs: { allow: [process.cwd(), hostRoot] } },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
