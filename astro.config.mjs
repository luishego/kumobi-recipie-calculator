// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

// Kumobi — Panel de Costeo de Recetas.
// SSR obligatorio: rutas privadas protegidas por cookie de sesión en el middleware.
// El adaptador (hosting) quedó abierto en fase 01; se usa Node standalone como
// base portable. Sustituible por Vercel/Netlify sin tocar la app.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    react(),
    tailwind({ applyBaseStyles: false }),
  ],
  server: { port: 4321 },
});
