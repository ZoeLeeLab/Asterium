import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
export default defineConfig({
  plugins: [{ name: 'automation-adapter-license', generateBundle() { this.emitFile({ type: 'asset', fileName: 'LICENSE-ZOD.txt', source: readFileSync('node_modules/zod/LICENSE', 'utf8') }); } }],
  build: { target: 'node22', outDir: 'out/automation-adapter', emptyOutDir: true,
    lib: { entry: 'src/main/automation/automationAdapterSdk.ts', formats: ['es'], fileName: () => 'automation-adapter.mjs' },
    rolldownOptions: { external: [/^node:/] } },
});
