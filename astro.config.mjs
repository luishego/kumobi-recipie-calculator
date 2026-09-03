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
  // `platformProxy` expone los bindings de Cloudflare (D1, R2) durante
  // `astro dev`; sin él, `locals.runtime.env` viene vacío en local y los
  // endpoints de ventas responden "falta el binding".
  //
  // `remoteBindings: false` es necesario: el binding de D1 tiene `remote: true`
  // en wrangler.jsonc, y con los bindings remotos activos el adaptador intenta
  // abrir una sesión de vista previa contra Cloudflare que el token actual no
  // puede crear — y `astro dev` ni siquiera arranca. Con esto, el desarrollo
  // usa una copia LOCAL de D1 (`.wrangler/state`), que además es más seguro.
  // El `remote: true` de wrangler.jsonc sigue vigente para el resto de las
  // herramientas y para el despliegue.
  adapter: cloudflare({
    imageService: 'compile',
    platformProxy: { enabled: true, remoteBindings: false },
  }),
  integrations: [
    react(),
    tailwind({ applyBaseStyles: false }),
  ],
  server: { port: 4321 },
});
