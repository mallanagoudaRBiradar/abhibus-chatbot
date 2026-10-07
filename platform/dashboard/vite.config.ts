import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.TRIP_ROOMS_API ?? 'http://localhost:4100';
// The dashboard talks only to the platform server; same-origin via proxy so no CORS in dev.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, proxy: { '/console': API, '/v1': API, '/chat': API, '/demo': API, '/healthz': API } },
});
