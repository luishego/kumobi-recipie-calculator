/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  // Config pública de Firebase (cliente). Inyectada en BUILD (deben existir al compilar).
  readonly PUBLIC_FIREBASE_API_KEY: string;
  readonly PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  readonly PUBLIC_FIREBASE_PROJECT_ID: string;
  readonly PUBLIC_FIREBASE_STORAGE_BUCKET: string;
  readonly PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly PUBLIC_FIREBASE_APP_ID: string;
  // Secreto para firmar la cookie de sesión (HS256). En Cloudflare es var de
  // RUNTIME (se lee vía locals.runtime.env); en dev se toma de .env.
  readonly SESSION_SECRET?: string;
  // Duración de la cookie de sesión (ms). Opcional (default 5 días).
  readonly SESSION_COOKIE_MAX_AGE_MS?: string;
  // Llave maestra (AES-GCM) para cifrar los tokens de POS en reposo — épica 02
  // §5.3. En Cloudflare es secret de RUNTIME; en dev se toma de .env.
  readonly SALES_TOKEN_KEY?: string;
  // Solo desarrollo local: token y sucursal de prueba de Loyverse. En producción
  // el token vive cifrado en D1, no en el entorno.
  readonly LOYVERSE_ACCESS_TOKEN?: string;
  readonly LOYVERSE_TEST_STORE_ID?: string;
  readonly LOYVERSE_TEST_TIMEZONE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Datos que el middleware/adaptador inyectan en `Astro.locals`. */
declare namespace App {
  interface Locals {
    user: {
      uid: string;
      email: string | null;
      role: string | null;
      /** Inquilino de la sesión (épica 02 §5.8). `null` en cookies antiguas. */
      tenantId: string | null;
    } | null;
    /**
     * Inyectado por el adaptador de Cloudflare: env y contexto del Worker.
     *
     * `env` mezcla variables de texto (secrets, vars) con BINDINGS de recursos,
     * que son objetos, no cadenas. Cada recurso tiene su propio binding y son
     * independientes entre sí: Cloudflare no relaciona la base con el bucket.
     * El vínculo entre un ticket y su payload crudo lo pone la columna
     * `raw_object_key` de `sales_receipts` (épica 02 §5.9).
     */
    runtime?: {
      env: {
        [key: string]: unknown;
        SESSION_SECRET?: string;
        SESSION_COOKIE_MAX_AGE_MS?: string;
        SALES_TOKEN_KEY?: string;
        /** Base D1 de ventas (épica 02). */
        kumobi_ventas?: import('@cloudflare/workers-types').D1Database;
        /** Bucket R2 con el archivo del payload crudo del proveedor. */
        kumobi_ventas_raw?: import('@cloudflare/workers-types').R2Bucket;
      };
    };
  }
}
