import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      external: ['@anthropic-ai/claude-agent-sdk'],
    },
  },
});
