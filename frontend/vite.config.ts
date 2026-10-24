import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const api = process.env.API_URL ?? 'http://localhost:8787';

export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['quickjs-emscripten', 'quickjs-emscripten-core', '@jitl/quickjs-wasmfile-debug-sync', '@jitl/quickjs-wasmfile-debug-asyncify', '@jitl/quickjs-wasmfile-release-sync', '@jitl/quickjs-wasmfile-release-asyncify'] },
  build: {
    rollupOptions: {
      output: { chunkFileNames: (chunk) => chunk.facadeModuleId?.endsWith('/packages/animlib/dist/index.js') ? 'assets/animation-engine-[hash].js' : 'assets/[name]-[hash].js' },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/owl.svg', 'icons/learn45.png'],
      manifest: {
        name: 'AIthena for Learn45',
        short_name: 'AIthena',
        description: 'Prototype: sign-in with a DCC profile, a learning map as a mind map, next steps with reasons.',
        lang: 'en',
        start_url: '/',
        display: 'standalone',
        background_color: '#F7F5F4',
        theme_color: '#DA291C',
        icons: [
          { src: 'icons/owl-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/owl-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/owl-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Load the large renderer on demand. Audio/manifest/WASM require a network;
        // a failed load offers the already bundled storyboard instead.
        globIgnores: ['**/animation-engine-*.js'],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/videos\//],
        runtimeCaching: [
          {
            // Content (lessons, personas) for offline use; sessions always go to the network.
            urlPattern: ({ url }) => url.pathname === '/api/content',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'content' },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': api,
      '/videos': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
});
