// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';

// Kumobi — Panel de Costeo de Recetas.
// SSR obligatorio: rutas privadas protegidas por cookie de sesión en el middleware.
// Hosting: Cloudflare Pages (runtime edge). La sesión es edge-native (jose /
// Web Crypto, sin firebase-admin); ver src/lib/session.ts.
export default defineConfig({
  output: 'server',
  // imageService: 'compile' → no usar sharp en el runtime edge (no hay imágenes
  // optimizadas en runtime); evita el warning del adaptador.
  adapter: cloudflare({ imageService: 'compile' }),
  integrations: [
    react(),
    tailwind({ applyBaseStyles: false }),
  ],
  server: { port: 4321 },
});
