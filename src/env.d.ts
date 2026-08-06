/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_FIREBASE_API_KEY: string;
  readonly PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  readonly PUBLIC_FIREBASE_PROJECT_ID: string;
  readonly PUBLIC_FIREBASE_STORAGE_BUCKET: string;
  readonly PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly PUBLIC_FIREBASE_APP_ID: string;
  // Admin SDK — modo archivo (recomendado): ruta al JSON de cuenta de servicio.
  readonly FIREBASE_ADMIN_CREDENTIALS_FILE?: string;
  // Admin SDK — modo variables sueltas (alternativa al archivo).
  readonly FIREBASE_ADMIN_PROJECT_ID?: string;
  readonly FIREBASE_ADMIN_CLIENT_EMAIL?: string;
  readonly FIREBASE_ADMIN_PRIVATE_KEY?: string;
  readonly SESSION_COOKIE_MAX_AGE_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Datos de sesión que el middleware inyecta en `Astro.locals`. */
declare namespace App {
  interface Locals {
    user: {
      uid: string;
      email: string | null;
      role: string | null;
    } | null;
  }
}
