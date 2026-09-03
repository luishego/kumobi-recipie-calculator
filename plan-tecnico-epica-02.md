# Plan técnico — Épica 02: Sincronización de ventas desde Loyverse

- **Proyecto:** Kumobi (inquilino #1 de un producto multi-cliente)
- **Fecha:** 2026-09-01
- **Especificación:** `01-requerimientos/epica-02-sync-ventas-loyverse.md` (v1.9)
- **Conciliación previa:** `01-requerimientos/conciliacion-base-2026-09-01.md` — 104 días, seis campos, $0.00
- **Estado del código base:** Astro 5 SSR sobre Cloudflare Workers, en producción en `calculator.kumobi.com.mx`

> **Punto de partida excepcional.** Las reglas de normalización ya están validadas contra el reporte del Back Office **antes** de escribir código. Este plan las convierte en software sin reabrir ninguna decisión semántica: lo que queda es ingeniería, y el criterio de "terminado" de cada fase es objetivo.

---

## 1. Restricciones que condicionan el diseño

| Restricción | Origen | Consecuencia en el plan |
|---|---|---|
| Runtime edge (Workers), sin Node | Adaptador `@astrojs/cloudflare` en producción | Web Crypto en vez de `node:crypto`; nada de `firebase-admin` en runtime (ya resuelto así en `src/lib/session.ts`) |
| D1 plan gratuito: 100 000 filas escritas/día; al agotarlo **deja de aceptar consultas** | §5.1 | Presupuesto diario de escritura en el backfill, como mecanismo real y no como adorno |
| Rate limit de Loyverse ≈300 req/300 s por token | §9 | Serialización por cuenta y backoff exponencial |
| El almacenamiento debe poder migrar a base propia | §5.10 | Toda consulta detrás de una capa de repositorio; SQL compatible con PostgreSQL; dinero en enteros |
| Multi-inquilino desde el diseño | §5.8 | `tenant_id` en cada tabla y en el claim de sesión, filtrado en un solo punto |

---

## 2. Dónde vive cada cosa

### 2.1 Decisión de arquitectura: **dos Workers, no uno**

El job de sincronización **no** se monta dentro del Worker que genera Astro. Se despliega como un Worker independiente en el mismo repositorio.

- El adaptador de Astro emite un Worker cuyo entrypoint (`dist/_worker.js/index.js`) expone un handler `fetch`. Un Cron Trigger necesita un handler `scheduled`, y envolver el bundle generado para añadírselo es frágil: se rompe en cada cambio del adaptador.
- Más allá de eso, **separarlos es mejor de todos modos**: el job es de larga duración y sin HTTP, mientras que el panel es interactivo. Un backfill pesado no debe competir por el presupuesto de ejecución del panel, y un fallo del job no debe poder tumbar la aplicación que el chef está usando.
- Los dos Workers comparten **las mismas bindings de D1 y R2** y el mismo código de dominio, importado por ruta relativa. No hay duplicación de lógica: hay dos entrypoints sobre un núcleo común.

```
03-desarrollo/
├─ src/                          # app Astro (existente)
│  ├─ lib/
│  │  ├─ sales/                  # ← NÚCLEO NUEVO, compartido por ambos Workers
│  │  │  ├─ types.ts             # SalesReceipt, SalesReceiptLine, SalesAccount…
│  │  │  ├─ provider.ts          # interfaz SalesProvider + errores de dominio
│  │  │  ├─ loyverse/
│  │  │  │  ├─ adapter.ts        # implementación del contrato (I/O)
│  │  │  │  ├─ normalize.ts      # función PURA: payload crudo → modelo
│  │  │  │  └─ normalize.test.ts
│  │  │  ├─ money.ts             # toCents / fromCents
│  │  │  ├─ businessDate.ts      # UTC + timezone → YYYY-MM-DD local
│  │  │  ├─ crypto.ts            # AES-GCM sobre Web Crypto
│  │  │  ├─ repo/                # ÚNICO lugar con SQL
│  │  │  │  ├─ index.ts          # createRepo(db, tenantId)
│  │  │  │  ├─ receipts.ts
│  │  │  │  ├─ accounts.ts
│  │  │  │  ├─ stores.ts
│  │  │  │  └─ syncState.ts
│  │  │  ├─ archive.ts           # escritura del crudo en R2
│  │  │  └─ sync/
│  │  │     ├─ backfill.ts
│  │  │     ├─ incremental.ts
│  │  │     └─ budget.ts         # presupuesto diario de escritura
│  │  └─ …                       # session.ts, costing.ts… (existentes)
│  ├─ pages/
│  │  ├─ ventas/                 # UI nueva (HU-14, HU-17)
│  │  └─ api/sales/              # endpoints de administración
│  └─ components/islands/        # islas React nuevas
├─ workers/
│  └─ sync/
│     ├─ index.ts                # handler `scheduled` + `fetch` de disparo manual
│     └─ wrangler.jsonc
├─ migrations/                   # migraciones de D1 (SQL versionado)
│  ├─ 0001_sales_schema.sql
│  ├─ 0002_seed_tenant_kumobi.sql
│  └─ README.md
└─ fixtures/                     # datos reales anonimizados, para las pruebas
   ├─ loyverse-historico-2026-05-21_2026-09-01.json
   └─ back-office-2026-05-21_2026-09-01.csv
```

### 2.2 Bindings

En `wrangler.jsonc` (app) y `workers/sync/wrangler.jsonc` (job), idénticos:

```jsonc
"d1_databases": [{ "binding": "kumobi_ventas", "database_name": "kumobi-ventas", "database_id": "231ea527-…" }],
"r2_buckets":   [{ "binding": "kumobi_ventas_raw", "bucket_name": "kumobi-ventas-raw" }],
```

> **Estado real al 2026-09-02:** D1 creada y migrada, y bucket R2 `kumobi-ventas-raw` creado. Los bindings quedaron como `kumobi_ventas` y `kumobi_ventas_raw` (no `DB` y `RAW` como decía el borrador de este plan), declarados en `wrangler.jsonc` y tipados en `src/env.d.ts`. **Fase 0 completa.**

Y solo en el job:

```jsonc
"triggers": { "crons": ["0 9 * * *"] }   // 03:00 hora de México — decidido 2026-09-01
```

> Cloudflare programa los crons en **UTC**. México no observa horario de verano desde 2022, así que `America/Mexico_City` es UTC−6 todo el año y `0 9 * * *` cae siempre a las 03:00 locales, sin desfase estacional.

Se leen con el patrón que el proyecto ya usa (`readEnv(locals, …)` extendido para devolver bindings, no solo strings): en el Worker de sync llegan directo en `env`.

---

## 3. Fases

Cada fase termina en algo **verificable**, no en "código escrito". El orden respeta el de ejecución de la épica: el adapter se valida antes de construirle encima.

### Fase 0 — Infraestructura y esquema *(1 sesión)*

1. Crear la base D1 `kumobi-ventas` y el bucket R2 `kumobi-ventas-raw`.
2. `migrations/0001_sales_schema.sql` con el DDL del §12 de la épica: 9 tablas (las 8 del modelo más `d1_write_budget`), índices únicos incluidos.
3. Bindings en los dos `wrangler.jsonc`; `env.d.ts` extendido con `kumobi_ventas: D1Database` y `kumobi_ventas_raw: R2Bucket`.
4. Semilla: el inquilino Kumobi en `tenants`.
5. Esqueleto de `workers/sync/index.ts` con `scheduled` que solo registra que corrió.

**Verificable:** `wrangler d1 migrations apply` en local y remoto; el cron dispara y deja rastro en los logs; `wrangler d1 execute --command "SELECT * FROM tenants"` devuelve Kumobi.

### Fase 1 — Adapter y normalización *(1–2 sesiones)* · HU-05

Es la pieza base y por eso va primero y sola.

1. `provider.ts`: contrato `SalesProvider` con `validateCredentials`, `listStores`, `fetchReceipts`, y el conjunto cerrado de errores (`INVALID_TOKEN`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `UNKNOWN`).
2. `normalize.ts`: **función pura**, sin red y sin base de datos. Aplica las reglas ya validadas:
   - importes a **centavos enteros** (`money.ts`);
   - `total_money` del renglón **tal cual** — nunca `quantity × price`;
   - **no** restar `total_discount`;
   - impuesto **leído** de `total_taxes`, nunca deducido;
   - `business_date` con `Intl.DateTimeFormat('en-CA', { timeZone })`;
   - `tip` y `surcharge` mapeados aunque hoy siempre lleguen en cero.
3. `adapter.ts`: solo I/O — autenticación por `Bearer`, paginación por cursor, traducción de errores. Devuelve además el **payload crudo de la página** para archivarlo.
4. ~~Resolver la incógnita del cursor~~ **Resuelto el 2026-09-01** contra la cuenta real: pedir la página siguiente solo con `cursor` + `limit`, o repitiendo además `store_id`, devuelve la misma página. El adapter envía solo `cursor` + `limit`; el backfill persiste igualmente los parámetros originales por si el comportamiento cambiara.

**Verificable — y aquí está el corazón del plan:** una prueba de Vitest que carga `fixtures/loyverse-historico.json`, normaliza, agrega por `business_date` y **compara contra el CSV del Back Office**, exigiendo $0.00 en los seis campos y misma cobertura de días. Es la conciliación de hoy convertida en **prueba de regresión permanente**: cualquier cambio futuro que rompa una de las seis reglas falla el build.

Más las pruebas de caso de la épica: reembolso, reembolso de día anterior, cancelado, recibo sin impuesto, renglón con modificadores de precio, descuento, ticket que cruza la medianoche local, página vacía.

### Fase 2 — Persistencia idempotente *(1–2 sesiones)* · HU-11 (datos)

1. `repo/`: **único lugar del sistema con SQL**. `createRepo(db, tenantId)` devuelve métodos que ya llevan el filtro por inquilino; ningún endpoint escribe SQL suelto.
2. Upsert portable:
   ```sql
   INSERT INTO sales_receipts (…) VALUES (…)
   ON CONFLICT (provider, account_id, store_id, receipt_number) DO UPDATE SET …
     WHERE excluded.provider_updated_at >= sales_receipts.provider_updated_at
   ```
   Sintaxis común a SQLite y PostgreSQL (§5.10). Los renglones se **reemplazan en bloque** por recibo.
3. Escrituras agrupadas con `db.batch()`, en lotes acotados de recibos para no pasarse del límite de sentencias por batch.

**Verificable:** insertar el histórico completo dos veces seguidas deja exactamente 108 recibos y los mismos renglones; y una consulta SQL de agregación sobre D1 reproduce los seis totales de la conciliación.

### Fase 3 — Cuentas, sucursales y multi-inquilino *(2 sesiones)* · HU-06, HU-07

1. `crypto.ts`: AES-GCM con Web Crypto, llave de `SALES_TOKEN_KEY`, IV de 12 bytes nuevo por cifrado. El token descifrado nunca sale del servidor; la UI solo ve `tokenLast4`.
2. `tenantId` en el claim de Firebase y sellado en la cookie de sesión: tocar `src/lib/session.ts`, `src/env.d.ts`, `src/middleware.ts` y `scripts/set-claim.mjs`.
   > **Migración de sesiones vivas:** las cookies ya emitidas no traen `tenantId`. Durante el despliegue se trata `tenantId` ausente como Kumobi y se fuerza la renovación de la cookie; pasado el periodo, ausente = rechazo.
3. Endpoints de administración y las islas React de alta de cuenta y listado de sucursales, con Zod y el patrón de formularios que ya usa el proyecto.

**Verificable:** dar de alta la cuenta real con el token del `.env`, ver que se descubre la sucursal KUMOBI sola, y comprobar en la base que el token está cifrado. Con un segundo inquilino de prueba, que ninguna consulta cruce la frontera.

### Fase 4 — Backfill reanudable y archivo del crudo *(2 sesiones)* · HU-08, §5.9

1. `archive.ts`: cada página cruda a R2 con la clave `raw/{tenant}/{account}/{store}/{YYYY-MM-DD}/{run}-{page}.json`, **antes** de normalizar. El recibo guarda `raw_object_key`.
2. `backfill.ts`: paginación completa con `backfill_cursor` persistido; `backfillMaxDays` por cuenta (30 por defecto, **null para Kumobi**); estado `PENDING → RUNNING → COMPLETE`, más `pausado por presupuesto`.
3. `budget.ts`: contador de filas escritas por día; al llegar a `DAILY_WRITE_BUDGET` (80 000) la corrida se detiene limpiamente y continúa en la siguiente.
4. El checkpoint solo se fija **al completar** el histórico, con el `cutoff_at` capturado al inicio.

**Verificable:** backfill de Kumobi sin tope → 108 recibos, una sola página, checkpoint puesto; y el mismo backfill interrumpido a la mitad a propósito continúa donde quedó sin duplicar nada.

### Fase 5 — Incremental y resiliencia *(2 sesiones)* · HU-09, HU-12, HU-13

1. `incremental.ts`: por sucursal activa con backfill completo, `updated_at_min = last_synced_at − 10 min`, `cutoff_at` al inicio, checkpoint solo si termina bien, sucursales de una cuenta **en serie**.
2. Backoff exponencial con variación aleatoria ante 429 y 5xx; máximo de reintentos acotado; sin bucles cerrados.
3. 401 → cuenta a `INVALID_TOKEN`, se detiene su sincronización, un solo reintento por corrida programada; rotación de token la devuelve a `ACTIVE` con el checkpoint intacto.
4. Escritura de `sync_runs` en cada corrida, con conteos.

**Verificable:** con un token inválido a propósito, la cuenta queda marcada y las demás siguen; simulando 429 se observa el backoff; tras dos corridas seguidas los conteos no cambian (idempotencia).

### Fase 6 — Visibilidad y mapeo *(2 sesiones)* · HU-14, HU-15, HU-11 (mapeo)

1. Pantalla de estado por sucursal: última sincronización exitosa, estado de la última corrida, backfill, fallos consecutivos, **consumo de cuota de D1 y tamaño de la base**, marca visual pasadas 36 h.
2. Re-sincronización manual de un rango, que **no** mueve el checkpoint y queda en la bitácora con quién la disparó.
3. Mapeo ítem/variante ↔ receta: propuesta automática por SKU y luego por nombre normalizado, confirmación manual, y visibilidad de los **no mapeados**. El mapeo se aplica **en la consulta**, no se congela en el renglón.

**Verificable:** la pantalla refleja una corrida real; una re-sincronización de un rango ya cargado no altera ningún total; los ítems sin mapear se ven y se cuentan.

### Fase 7 — Conciliación en producción y compuerta *(1 sesión)* · HU-16 → HU-17

1. El mismo cálculo de la Fase 1, ahora **leyendo de D1** en vez del fixture, expuesto como reporte con la columna de Loyverse para pegar y la diferencia por día y por campo.
2. Se re-corre contra el reporte del Back Office ya conocido. **Criterio: $0.00 en los seis campos y misma cobertura de días.**
3. Solo entonces se construye HU-17 (vista mínima de ventas) y se abre la épica 03.

**Verificable:** el reporte en pantalla reproduce exactamente `conciliacion-base-2026-09-01.md`. Si no lo hace, es un bug de implementación con un origen acotado —ninguna regla está en duda.

---

## 4. Detalles técnicos que conviene fijar antes de teclear

**Dinero.** `toCents(x)` = `Math.round(Number(x) * 100)`. Es exacto para los importes de dos decimales que entrega Loyverse, y la prueba de conciliación lo verifica sobre los 108 recibos reales, así que no hace falta una librería decimal. `fromCents` solo se usa al presentar.

**Fecha de negocio.** `Intl.DateTimeFormat('en-CA', { timeZone })` da `YYYY-MM-DD` directo y funciona en el runtime de Workers. Se calcula **una vez, al escribir**, y se persiste; nunca se recalcula al consultar.

**Cursor.** Se persiste el cursor **y** los parámetros originales de la consulta. Así el backfill reanuda correctamente sin importar cuál de los dos comportamientos tenga la API, y la incógnita deja de ser bloqueante.

**Aislamiento por inquilino.** `createRepo(db, tenantId)` es la única puerta. El `tenantId` sale siempre de la sesión, nunca del request. Conviene una prueba que recorra el módulo `repo/` y falle si aparece una consulta sin filtro de inquilino.

**Zona horaria por sucursal.** `America/Mexico_City` para Kumobi, editable. `business_day_offset_minutes` queda en el esquema en 0, sin implementar.

---

## 5. Estrategia de pruebas

| Nivel | Qué cubre | Herramienta |
|---|---|---|
| **Conciliación** | Las seis reglas de negocio contra datos reales y el reporte del Back Office | Vitest sobre los fixtures |
| Unitarias | `money`, `businessDate`, `crypto`, `budget`, normalización caso por caso | Vitest |
| Idempotencia | Doble escritura del mismo rango | Vitest contra D1 local |
| Aislamiento | Dos inquilinos, ninguna fuga | Vitest contra D1 local |
| Manual | Alta de cuenta, rotación de token, pantallas | Navegador |

Se suma a los 27 tests existentes, que deben seguir en verde. Los fixtures se guardan **anonimizados**: sin `customer_id`, `employee_id` ni notas libres.

---

## 6. Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| El adaptador de Astro cambia y rompe el Worker de la app | Media | Los dos Workers están separados; el de sync no depende del build de Astro |
| El `cursor` de Loyverse se comporta distinto de lo supuesto | Media | Se persisten cursor y parámetros; se resuelve empíricamente en la Fase 1 |
| Aparece el primer recibo con propina y el total la trata distinto | Baja, impacto alto | La prueba de conciliación lo detecta en la primera corrida posterior; `tip` ya está en el modelo |
| Agotar la cuota de D1 y dejar la app sin base | Baja (Kumobi ~400 filas) | Presupuesto diario desde la Fase 4, antes de cualquier carga grande |
| Sesiones vivas sin `tenantId` al desplegar la Fase 3 | Alta, impacto bajo | Periodo de gracia con renovación forzada de cookie |

---

## 7. Secuencia y esfuerzo

| Fase | Contenido | Esfuerzo |
|---|---|---|
| 0 | Infraestructura y esquema | 1 sesión |
| 1 | Adapter, normalización y prueba de conciliación | 1–2 |
| 2 | Persistencia idempotente | 1–2 |
| 3 | Cuentas, sucursales, multi-inquilino | 2 |
| 4 | Backfill reanudable y archivo en R2 | 2 |
| 5 | Incremental y resiliencia | 2 |
| 6 | Visibilidad y mapeo | 2 |
| 7 | Conciliación en producción → compuerta | 1 |
| | **Total** | **12–14 sesiones** |

Las fases 0 a 2 no tienen interfaz de usuario, así que el **diseño UX/UI de las pantallas de las fases 3, 6 y 7 puede hacerse en paralelo** desde el primer día.

---

## 8. Qué hace falta antes de empezar

- [ ] Aprobación de este plan por el líder técnico.
- [ ] Crear la base D1 y el bucket R2 en la cuenta de Cloudflare (Fase 0).
  > El token de wrangler de la cuenta (`adminsolcre@gmail.com`, `3ef30388…`) tiene `d1 (write)` pero **no tiene alcance de R2**: `wrangler r2 bucket create` falla hasta volver a hacer `wrangler login` o crear el bucket desde el panel.
- [x] `SALES_TOKEN_KEY` generada y guardada en `.env` **para desarrollo local**. Falta cargarla como **secret del Worker** para producción — `.env` no llega al runtime de Cloudflare (mismo caso que dio un 500 con `SESSION_SECRET` en el despliegue inicial).
- [x] **Horario del cron confirmado:** una corrida diaria a las 03:00 hora de México (`0 9 * * *` en UTC).

Nada de esto bloquea la Fase 1, que es pura lógica con fixtures y puede arrancar de inmediato.
