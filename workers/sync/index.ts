// Worker de sincronización — épica 02, §5.2 y HU-09.
//
// Va SEPARADO del Worker que genera Astro, por dos razones:
//
//   1. El adaptador de Astro emite un entrypoint con handler `fetch`; un Cron
//      Trigger necesita `scheduled`, y envolver el bundle generado para
//      añadírselo se rompe en cada actualización del adaptador.
//   2. Aunque se pudiera, conviene: este job es de larga duración y sin HTTP,
//      mientras que el panel es interactivo. Un backfill pesado no debe competir
//      por el presupuesto de ejecución de la aplicación que el chef está usando,
//      y un fallo aquí no debe poder tumbarla.
//
// Comparte con la app los mismos bindings y TODO el código de dominio: son dos
// entrypoints sobre un mismo núcleo, no dos implementaciones.

import type { D1Database, R2Bucket, ScheduledController } from '@cloudflare/workers-types';
import { importMasterKey } from '../../src/lib/sales/crypto';
import { runNightlySync } from '../../src/lib/sales/sync/runAll';

export interface Env {
  kumobi_ventas: D1Database;
  kumobi_ventas_raw?: R2Bucket;
  SALES_TOKEN_KEY: string;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const inicio = Date.now();
    try {
      const masterKey = await importMasterKey(env.SALES_TOKEN_KEY);
      const resumen = await runNightlySync({
        db: env.kumobi_ventas,
        bucket: env.kumobi_ventas_raw,
        masterKey,
      });

      console.log(
        `[sync] ${resumen.sucursales} sucursales de ${resumen.cuentas} cuentas ` +
          `(${resumen.inquilinos} inquilinos) · ${resumen.receipts} tickets, ` +
          `${resumen.lines} renglones · ${resumen.fallidas} con fallo · ` +
          `${Date.now() - inicio} ms`,
      );

      for (const d of resumen.detalle) {
        if (d.outcome === 'SUCCESS' || d.outcome === 'SKIPPED_SIN_BACKFILL') continue;
        console.warn(`[sync] ${d.alias} / ${d.nombre || '—'}: ${d.outcome} ${d.error ?? ''}`);
      }
      if (resumen.cuentasInvalidadas.length) {
        console.error(
          `[sync] cuentas que requieren reconexión: ${resumen.cuentasInvalidadas.join(', ')}`,
        );
      }
    } catch (err) {
      // Que el cron falle entero es distinto a que falle una sucursal: esto
      // significa que ni siquiera se pudo empezar (llave, binding, base).
      console.error('[sync] la corrida no pudo completarse:', err);
      throw err;
    }
  },

  // Este Worker no atiende peticiones: existe solo para el Cron Trigger. Se
  // deja explícito para que un despliegue mal apuntado se note de inmediato.
  async fetch(): Promise<Response> {
    return new Response(
      'Worker de sincronización de ventas. No atiende peticiones; corre por Cron Trigger.',
      { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  },
};
