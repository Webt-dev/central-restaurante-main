import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Alvo conservador: celulares Android antigos (WebView ~Chrome 87) e iPhones com Safari 14.
    // Isso só reescreve a sintaxe (?., ??, etc.). NÃO usamos @vitejs/plugin-legacy: ele geraria um
    // segundo bundle com polyfills (pesado, ~2x o tamanho) e os aparelhos-alvo já têm tudo o que o
    // sistema usa (fetch, Promise, WebSocket, IndexedDB). Abaixo de Chrome 87/Safari 14 não é suportado.
    target: ['chrome87', 'safari14'],
    cssTarget: ['chrome87', 'safari14']
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
        secure: false
      }
    }
  }
})
