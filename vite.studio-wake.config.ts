import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [{ name: 'studio-wake-license', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'LICENSE-ZOD.txt', source: readFileSync('node_modules/zod/LICENSE', 'utf8') });
  } }],
  build: { target: 'node22', outDir: 'out/studio-wake-adapter', emptyOutDir: true,
    lib: { entry: 'src/main/studio/studioWakeAdapterSdk.ts', formats: ['es'], fileName: () => 'studio-wake-adapter.mjs' },
    rolldownOptions: { external: [/^node:/] } },
});
