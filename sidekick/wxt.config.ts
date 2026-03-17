import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  // Don't minify for easier debugging
  outDir: '.output',
  modules: [],
  manifest: {
    name: 'Sidekick',
    description: 'Browser extension for opportunistic automation via agent WebSocket',
    permissions: [
      'activeTab',
      'tabs',
      'scripting',
      'storage',
    ],
    host_permissions: [
      '<all_urls>',
    ],
  },
  vite: () => ({
    build: {
      minify: false,
    },
  }),
});
