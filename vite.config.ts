import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  base: '/webrtc-robot-demo/',

  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        cam: resolve(__dirname, 'cam.html'),
      },
      output: {
        manualChunks: {
          'pako': ['pako']
        }
      }
    }
  },

  server: {
    port: 3000
  }
})
