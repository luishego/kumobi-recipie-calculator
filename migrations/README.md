# Migraciones de D1 — capa de ventas

Base: **`kumobi-ventas`**. Esquema de la épica 02 (`01-requerimientos/epica-02-sync-ventas-loyverse.md`).

## Aplicar

Primero en local, siempre, y solo después en remoto:

```bash
npx wrangler d1 migrations apply kumobi-ventas --local
```

```bash
npx wrangler d1 migrations apply kumobi-ventas --remote
```

Wrangler lleva el control de lo aplicado en su propia tabla `d1_migrations`, así que re-ejecutar el comando no vuelve a correr lo que ya pasó.

Para ver qué falta por aplicar:

```bash
npx wrangler d1 migrations list kumobi-ventas --remote
```

> Requiere el binding de `kumobi-ventas` en `wrangler.jsonc` con su `database_id` real.

## Verificar

Las garantías del esquema están cubiertas por `src/lib/sales/schema.test.ts`, que aplica estas mismas migraciones sobre SQLite en memoria y comprueba idempotencia, restricciones de dominio, el centinela de variante y el borrado en cascada:

```bash
npm test
```

Si una migración futura rompe alguna de esas garantías, la prueba falla antes de que el SQL llegue a producción.

## Convenciones

Están documentadas en la cabecera de `0001_sales_schema.sql` y vienen de §5.10 de la épica (portabilidad a PostgreSQL):

- Ids generados por la **aplicación**, nunca por la base. Sin `AUTOINCREMENT`.
- Fechas en **TEXT ISO-8601 UTC**; `business_date` es la excepción: fecha local `YYYY-MM-DD`.
- Dinero en **INTEGER de centavos**, sufijo `_cents`. La única columna decimal es `quantity`.
- `tenant_id` en todas las tablas, incluso donde sería deducible.
- SQL compatible con SQLite **y** PostgreSQL: `ON CONFLICT … DO UPDATE`, nunca `INSERT OR REPLACE`.

## Al agregar una migración

1. Numeración correlativa: `0003_lo_que_sea.sql`.
2. **SQLite casi no permite `ALTER TABLE`**: cambiar una columna implica crear la tabla nueva, copiar y renombrar. Conviene pensarlo dos veces antes de dar por buena una columna.
3. Agregar o ajustar la prueba correspondiente en `schema.test.ts`.
4. Aplicar en local, correr `npm test`, y solo entonces aplicar en remoto.
