import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const hostRoot = resolve(process.env.DSH_HOST_SOURCE ?? '../deepseek-harness')
const hostPrimitives = resolve(hostRoot, 'packages/client/ui-primitives/src')
const disclosureRow = resolve(hostPrimitives, 'DisclosureRow.tsx')
const primitivesFacade = '\0dsh-test-primitives'
const hostConfig = resolve(hostRoot, 'tsconfig.base.json')
// Resolve the source-engine suite through the Host's own workspace paths.
const paths: Record<string, readonly string[]> = existsSync(hostConfig)
  ? ts.readConfigFile(hostConfig, ts.sys.readFile).config.compilerOptions.paths
  : {}

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [{
    name: 'dsh-host-source-paths',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === '@deepseek-ai/dsh-client-ui-primitives' && !importer?.startsWith(`${hostRoot}/`)) return primitivesFacade
      if (!importer?.startsWith(`${hostRoot}/`) || !Object.hasOwn(paths, id)) return null
      const target = paths[id]?.[0]
      return target === undefined ? null : this.resolve(resolve(hostRoot, target), importer, { skipSelf: true })
    },
    load(id) {
      if (id !== primitivesFacade) return
      // Load only the real primitives used here, not the Web shell's full static barrel.
      if (existsSync(disclosureRow)) return `
        export { DisclosureRow } from ${JSON.stringify(disclosureRow)};
        export { IconClockOutlineRegular } from ${JSON.stringify(resolve(hostPrimitives, 'icons/index.tsx'))};
      `
      // Standalone tests never render this card; the engine suite needs Host source.
      return 'export const IconClockOutlineRegular = undefined; export function DisclosureRow() { throw new Error("DisclosureRow requires DSH Host source in tests") }'
    },
  }],
  server: { fs: { allow: [process.cwd(), hostRoot] } },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
