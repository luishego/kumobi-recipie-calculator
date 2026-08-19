# Kumobi — Panel de Costeo de Recetas (MVP)

Panel interno de administración para el **control del Food Cost y el margen del menú**
de un restaurante: insumos → recetas/sub-recetas anidadas → platillos finales.

Herramienta interna detrás de login (`noindex`). Español (México), moneda **MXN**.

## Stack

- **Astro (SSR)** con adaptador **Cloudflare** (runtime edge) + islas **React** (`client:load`).
- **Tailwind CSS** con tokens semánticos del sistema de diseño (fase 02).
- **Firebase Web SDK v10** (Auth + Firestore) en el cliente.
- **Sesión edge-native con `jose`** (Web Crypto) en el servidor — **sin firebase-admin**.
- **React Hook Form + Zod** en los formularios.

## Arquitectura relevante

- **Auth / rutas privadas (edge-native, sin firebase-admin):** login cliente con
  `signInWithEmailAndPassword` → `idToken` → `POST /api/session` **verifica el ID token
  contra los certificados públicos de Google** (`jose` + Web Crypto) y acuña **nuestra
  propia cookie de sesión** (JWT HS256 firmado con `SESSION_SECRET`). `src/middleware.ts`
  verifica esa cookie en cada ruta privada; sin cookie válida → redirect a `/login`.
  Logout borra la cookie (`DELETE /api/session`). Ver `src/lib/session.ts`.
  (No hay revocación de sesión, a diferencia de `createSessionCookie`; aceptable para
  herramienta interna, las Firestore Rules siguen exigiendo el rol.)
- **La UI NO calcula ni persiste** `netCostPerUsageUnit`, los campos financieros de
  recetas (`calculatedCost`, `totalCost`, `costPerYieldUnit`, `foodCostPercentage`,
  `contributionMargin`) ni `requiresRecalculation`. Eso lo hacen **Cloud Functions**
  (fuera de este alcance). La UI muestra **previews informativos** (marcados con ℹ,
  color `info`) y **lee** los valores oficiales de Firestore.
- **Anidación de recetas:** detección de ciclos con **DFS** + **límite de profundidad**
  (`MAX_DEPTH` en `src/lib/constants.ts`) en `src/lib/graph.ts`. Se valida en la UI;
  el backend re-valida como fuente de verdad.
- **`conversionFactor` tiene dos semánticas** (ver `src/lib/types.ts`):
  `unit-config` = unidades base por unidad; `ingredients` = unidades de uso por unidad
  de compra. No se confunden en el código de costeo.

## Estructura

```
src/
  middleware.ts              # guard de sesión SSR
  env.d.ts
  styles/global.css          # Tailwind + tokens base
  lib/
    types.ts                 # esquemas de Firestore (tipos)
    constants.ts             # MAX_DEPTH, colecciones, umbrales Food Cost
    format.ts                # Intl MXN / % / costo unitario
    costing.ts               # fórmulas de PREVIEW (no fuente de verdad)
    graph.ts                 # DFS anti-ciclos + profundidad
    firebase/client.ts       # Web SDK (Auth + Firestore)
    firebase/admin.ts        # Admin SDK (cookies de sesión)
    firebase/hooks.ts        # hooks de datos para las islas
  components/
    ui/                      # Button, Field, Badge, Modal, Alert, Toggle, Combobox…
    islands/                 # LoginForm, IngredientsPanel, RecipeBuilder, Dashboard…
  layouts/DashboardLayout.astro
  pages/
    login.astro
    index.astro              # Dashboard (HU-04)
    insumos.astro            # Insumos (HU-02)
    recetas/index.astro      # Lista de recetas
    recetas/nueva.astro      # Constructor (HU-03)
    recetas/[id].astro       # Editar receta
    api/session.ts           # POST idToken→cookie · DELETE logout
```

## Requisitos

- Node.js 18.20+ (o 20/22). Probado con Node 26.
- Un proyecto Firebase con **Authentication** (Email/Password) y **Firestore**, con las
  colecciones `unit-config`, `categories`, `ingredients`, `recipes`. Se asumen las
  **Security Rules** y **Cloud Functions** de cálculo ya existentes (fuera de alcance).

## Configuración

1. Instala dependencias:
   ```bash
   npm install
   ```
2. Copia el archivo de entorno y rellénalo con tus credenciales de Firebase:
   ```bash
   cp .env.example .env
   ```
   - `PUBLIC_FIREBASE_*`: config web (Firebase Console → Configuración → Tus apps).
   - `FIREBASE_ADMIN_*`: credenciales de cuenta de servicio (Cuentas de servicio →
     Generar nueva clave privada). **Secretas**; no se suben al repo.
   - Los usuarios deben tener un `role` válido en Custom Claims (`admin`/`chef`/`manager`).
     El alta de usuarios y claims está fuera de este alcance.

## Ejecutar

```bash
npm run dev        # http://localhost:4321
npm run build      # build de producción (SSR)
npm run preview    # sirve el build (node ./dist/server/entry.mjs)
npm run typecheck  # verificación de tipos (tsc --noEmit)
npm run check      # astro check (diagnóstico de .astro + tipos)
```

## Tests

Pruebas unitarias de la lógica pura de `src/lib` (Vitest):

```bash
npm test          # una corrida (vitest run)
npm run test:watch
```

- `src/lib/costing.test.ts` — costo neto, costeo de renglón con conversión, semáforo Food Cost.
- `src/lib/graph.test.ts` — anti-ciclos (DFS) y límite de profundidad.

## Cloud Functions (propagación)

En `functions/`. Marcan `requiresRecalculation` en cascada cuando cambia un insumo y
registran `price_history`. Ver `functions/README.md` para instalar, compilar y desplegar
(`firebase deploy --only functions`). Requiere Firebase CLI y plan Blaze.

## Asignar Custom Claims (usuarios)

```bash
npm run set-claim -- correo@ejemplo.mx admin   # role: admin | chef | manager
```

## Despliegue (Cloudflare Pages)

Adaptador: `@astrojs/cloudflare` (`output: 'server'`). El comando de build es
`npm run build` (genera `dist/` + el Worker). En el dashboard de Cloudflare Pages:

**Variables de entorno (Production).** Dos grupos:

- **Build (cliente) — las 6 `PUBLIC_FIREBASE_*`.** Astro las inyecta EN BUILD, así que
  deben existir ANTES de compilar. Si las agregas después, hay que **re-desplegar**.
- **Runtime (servidor):**
  - `SESSION_SECRET` — secreto largo aleatorio para firmar la cookie de sesión.
  - `SESSION_COOKIE_MAX_AGE_MS` — opcional (default 5 días).

Ya **no** se necesitan `FIREBASE_ADMIN_*` ni el `serviceAccount.json` en el servidor
(la sesión es edge-native).

**Firebase Console → Authentication → Settings → Dominios autorizados:** agrega el
dominio de producción (p. ej. `calculator.kumobi.com.mx`).

> Nota: el adaptador habilita las *Astro Sessions* con un binding KV llamado `SESSION`.
> Esta app **no** usa `Astro.session`, así que en la práctica no se accede. Si el deploy
> fallara con *"Invalid binding `SESSION`"*, crea un KV namespace y bíndalo como `SESSION`
> en Pages → Settings → Functions → KV namespace bindings.

## Estado de verificación

- **Verificado end-to-end contra Firebase real (2026-08-04):** las 4 HU funcionan
  (login/guard SSR, insumos con costeo, recetas con Food Cost, dashboard). Ver
  `../05-entrega/reporte-qa.md`.
- **Build/tests:** `npm run build`, `npm run typecheck` y `npm test` (22/22) en verde.
- **Arquitectura de cálculo:** el **cliente calcula y escribe** los campos financieros
  (las Security Rules los validan); las Cloud Functions solo **propagan**
  (`requiresRecalculation` + `price_history`).
- **Pendientes no bloqueantes:** desplegar Functions y reglas (cliente, vía CLI);
  adaptador/hosting definitivo (hoy Node standalone); marca Kumobi (tokens `primary`
  sustituibles); limpiar datos de prueba en Firestore.
- **No-indexación:** `<meta name="robots" content="noindex, nofollow">` en login y layout.
```
