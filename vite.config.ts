import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 10111,
    strictPort: true,
    // Preserve the browser-facing Host (including :10111) for the master's origin check.
    proxy: { '/api': { target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:10110', changeOrigin: false } },
  },
})
