import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { execFileSync } from 'node:child_process';

const packagedRuntimeRoots = [
  '/.vite',
  '/node_modules/@anthropic-ai/claude-agent-sdk',
];

function keepPackagedRuntimePath(file: string) {
  if (!file) return true;
  const normalized = file.replaceAll('\\', '/');
  return packagedRuntimeRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`) || root.startsWith(`${normalized}/`));
}

const config: ForgeConfig = {
  packagerConfig: {
    icon: 'assets/asterium.ico',
    asar: true,
    prune: false,
    extraResource: ['src/main/adapters/deliverFileMcp.cjs', 'third_party/mousecrew', 'third_party/mcp-client', 'third_party/yaml', 'third_party/licenses', 'THIRD_PARTY_NOTICES.md', '.sandbox-build/sandbox'],
    ignore: (file) => !keepPackagedRuntimePath(file),
  },
  rebuildConfig: {},
  makers: [],
  hooks: {
    preStart: async () => { execFileSync(process.execPath, ['scripts/build-windows-sandbox.mjs'], { stdio: 'inherit', windowsHide: true }); },
    prePackage: async () => { execFileSync(process.execPath, ['scripts/build-windows-sandbox.mjs'], { stdio: 'inherit', windowsHide: true }); },
  },
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
