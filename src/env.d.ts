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
    } | null;
    /** Inyectado por el adaptador de Cloudflare: env y contexto del Worker. */
    runtime?: {
      env: Record<string, string | undefined>;
    };
  }
}
