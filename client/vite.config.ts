import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.PORT ?? '5178';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API only accepts Host/Origin on port 5173 in dev; never move to another port.
    strictPort: true,
    proxy: {
      // In dev, forward API calls to the Fastify server.
      // Use 127.0.0.1 (not localhost) so it always hits the IPv4 the server binds.
      '/api': `http://127.0.0.1:${SERVER_PORT}`,
    },
  },
});
