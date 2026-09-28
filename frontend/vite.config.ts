import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `npm run dev` talks to the gateway from docker compose; in the container, nginx does this proxying.
  server: { proxy: { '/api': { target: process.env.GATEWAY_URL ?? 'http://localhost:8000', ws: true } } },
})
