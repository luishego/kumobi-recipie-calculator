// Estado de sincronización, cuota y bitácora — épica 02, HU-14 y HU-15.
//
// Es la pantalla que contesta dos preguntas que hoy solo se pueden responder
// abriendo el panel de Loyverse o la base a mano: "¿alguna sucursal dejó de
// sincronizar?" y "¿por qué hoy no entró nada?".
//
// ── Por qué el orden por defecto es por antigüedad y no alfabético ──────────
// Una lista alfabética obliga a leerla entera para encontrar el problema. Con
// la sucursal más rezagada arriba, la pantalla se lee en un vistazo y en el
// caso normal —todo al día— lo que se ve arriba es tranquilizador, no ruido.
//
// ── Por qué la cuota va arriba y no escondida ───────────────────────────────
// Agotar la cuota diaria de D1 no ralentiza la aplicación: la **deja sin base**
// (§5.1). Es el dato que anticipa una caída en vez de explicarla después.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { FieldWrap, TextInput } from '../ui/Field';
import { Toast, type ToastState } from '../ui/Toast';
import { ErrorState, TableSkeleton } from '../ui/states';
import { hoyLocal } from '../../lib/format';
import type { SyncRunRow, SyncStateRow } from '../../lib/sales/repo/syncState';

interface FilaSucursal {
  storeId: string;
  nombre: string;
  accountId: string;
  cuenta: string;
  cuentaStatus: string | null;
  timezone: string;
  activa: boolean;
  estado: SyncStateRow | null;
}

interface Cuota {
  escritasHoy: number;
  presupuesto: number;
  limiteDiario: number;
  tamanoBytes: number | null;
  avisoTamanoBytes: number;
  limiteTamanoBytes: number;
}

interface Respuesta {
  sucursales: FilaSucursal[];
  corridas: SyncRunRow[];
  umbralHoras: number;
  cuota: Cuota;
  ahora: string;
}

type Orden = 'antiguedad' | 'nombre';

// Sin la palabra "histórico" dentro: la etiqueta de la lista de definición ya
// la dice, y repetirla producía "Histórico Histórico completo".
const ETIQUETA_BACKFILL: Record<string, string> = {
  PENDING: 'pendiente',
  RUNNING: 'en curso',
  PAUSED_BUDGET: 'pausado por cuota',
  COMPLETE: 'completo',
  FAILED: 'fallido',
};

const ETIQUETA_TIPO: Record<string, string> = {
  BACKFILL: 'Histórico',
  INCREMENTAL: 'Nocturna',
  MANUAL: 'Manual',
};

const hoyIso = hoyLocal;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "hace 3 h", "hace 2 días". `null` cuando nunca ha ocurrido. */
function hace(iso: string | null, ahoraMs: number): string | null {
  if (!iso) return null;
  const ms = ahoraMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

function horasDesde(iso: string | null, ahoraMs: number): number | null {
  if (!iso) return null;
  const ms = ahoraMs - Date.parse(iso);
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

/** Instante local legible, sin recurrir a la fecha de negocio. */
function momento(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('es-MX', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
}

export default function EstadoSyncPanel() {
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orden, setOrden] = useState<Orden>('antiguedad');
  const [reparando, setReparando] = useState<string | null>(null);
  const [enCurso, setEnCurso] = useState(false);
  const [desde, setDesde] = useState(hoyIso());
  const [hasta, setHasta] = useState(hoyIso());
  const [toast, setToast] = useState<ToastState | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch('/api/sales/estado');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setDatos(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const ahoraMs = useMemo(
    () => (datos ? Date.parse(datos.ahora) : Date.now()),
    [datos],
  );

  const nombrePorSucursal = useMemo(
    () => new Map((datos?.sucursales ?? []).map((s) => [s.storeId, s.nombre] as const)),
    [datos],
  );

  const ordenadas = useMemo(() => {
    const filas = [...(datos?.sucursales ?? [])];
    if (orden === 'nombre') return filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    // Sin sincronización exitosa = lo más urgente, así que va primero y no
    // último: es el caso que hay que atender, no el que no tiene dato.
    return filas.sort((a, b) => {
      const va = a.estado?.lastSuccessAt ? Date.parse(a.estado.lastSuccessAt) : -Infinity;
      const vb = b.estado?.lastSuccessAt ? Date.parse(b.estado.lastSuccessAt) : -Infinity;
      return va - vb;
    });
  }, [datos, orden]);

  const rezagadas = useMemo(
    () =>
      ordenadas.filter((s) => {
        if (!s.activa) return false;
        const h = horasDesde(s.estado?.lastSuccessAt ?? null, ahoraMs);
        return h === null || h > (datos?.umbralHoras ?? 36);
      }),
    [ordenadas, ahoraMs, datos],
  );

  async function reparar(storeId: string) {
    setEnCurso(true);
    try {
      const res = await fetch(`/api/sales/stores/${encodeURIComponent(storeId)}/resync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ desde, hasta }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);

      const detalle =
        data.outcome === 'PAUSED_BUDGET'
          ? 'Se detuvo por cuota diaria; repite mañana.'
          : `${data.receipts} tickets y ${data.lines} renglones.`;
      setToast({ message: `Rango re-sincronizado. ${detalle}`, tone: 'success' });
      setReparando(null);
      await cargar();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setEnCurso(false);
    }
  }

  if (cargando) return <TableSkeleton rows={5} cols={5} />;
  if (error) return <ErrorState message={error} onRetry={() => void cargar()} />;
  if (!datos) return null;

  const { cuota, umbralHoras } = datos;
  const pctCuota = Math.min(100, Math.round((cuota.escritasHoy / cuota.presupuesto) * 100));
  // "0 %" junto a 392 filas escritas se lee como un error de la pantalla. Con
  // "<1 %" queda claro que hubo consumo y que es despreciable, que es justo lo
  // que el dato tiene que comunicar.
  const pctTexto = cuota.escritasHoy > 0 && pctCuota === 0 ? '<1 %' : `${pctCuota} %`;
  const tamanoAlto = cuota.tamanoBytes !== null && cuota.tamanoBytes > cuota.avisoTamanoBytes;

  return (
    <div className="space-y-6">
      {rezagadas.length > 0 && (
        <Alert tone="warning">
          <strong>
            {rezagadas.length === 1
              ? '1 sucursal activa lleva'
              : `${rezagadas.length} sucursales activas llevan`}{' '}
            más de {umbralHoras} h sin sincronizar
          </strong>{' '}
          ({rezagadas.map((s) => s.nombre).join(', ')}). Revisa abajo el motivo de su última
          corrida.
        </Alert>
      )}

      {tamanoAlto && (
        <Alert tone="warning">
          La base pasó de {mb(cuota.avisoTamanoBytes)} ({mb(cuota.tamanoBytes!)} de{' '}
          {mb(cuota.limiteTamanoBytes)} del plan gratuito). Es el disparador de §5.1 para
          evaluar el plan de pago, antes de que el límite lo decida por nosotros.
        </Alert>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-border-base bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Escrituras de hoy
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-text-strong">
            {cuota.escritasHoy.toLocaleString('es-MX')}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            de {cuota.presupuesto.toLocaleString('es-MX')} presupuestadas ({pctTexto})
          </p>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-app"
            role="img"
            aria-label={`${pctTexto} del presupuesto diario de escritura`}
          >
            <div
              className={`h-full rounded-full ${pctCuota > 80 ? 'bg-danger' : 'bg-primary'}`}
              style={{ width: `${Math.max(pctCuota, 1)}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-text-muted">
            El límite real de Cloudflare son {cuota.limiteDiario.toLocaleString('es-MX')} filas;
            al alcanzarlo la base deja de aceptar <em>consultas</em>, no solo escrituras. El
            presupuesto es menor a propósito.
          </p>
        </div>

        <div className="rounded-lg border border-border-base bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Tamaño de la base
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-text-strong">
            {cuota.tamanoBytes === null ? 'No disponible' : mb(cuota.tamanoBytes)}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            {cuota.tamanoBytes === null
              ? 'El runtime no reportó el tamaño en esta consulta.'
              : `Aviso a ${mb(cuota.avisoTamanoBytes)}, límite ${mb(cuota.limiteTamanoBytes)}`}
          </p>
        </div>

        <div className="rounded-lg border border-border-base bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Sucursales
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-text-strong">
            {datos.sucursales.filter((s) => s.activa).length}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            activas de {datos.sucursales.length}
            {rezagadas.length > 0 && ` · ${rezagadas.length} rezagada${rezagadas.length > 1 ? 's' : ''}`}
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-text-strong">Estado por sucursal</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Ordenar por</span>
            {(
              [
                ['antiguedad', 'Más rezagada'],
                ['nombre', 'Nombre'],
              ] as const
            ).map(([valor, etiqueta]) => (
              <Button
                key={valor}
                size="sm"
                variant={orden === valor ? 'primary' : 'secondary'}
                onClick={() => setOrden(valor)}
              >
                {etiqueta}
              </Button>
            ))}
            <Button size="sm" variant="secondary" onClick={() => void cargar()}>
              Actualizar
            </Button>
          </div>
        </div>

        <ul className="divide-y divide-border-base rounded-lg border border-border-base bg-surface">
          {ordenadas.map((s) => {
            const e = s.estado;
            const h = horasDesde(e?.lastSuccessAt ?? null, ahoraMs);
            const rezagada = s.activa && (h === null || h > umbralHoras);
            const abierto = reparando === s.storeId;

            return (
              <li key={s.storeId} className="space-y-3 px-4 py-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-text-strong">{s.nombre}</p>
                      {!s.activa && (
                        <span className="rounded-md bg-app px-2 py-0.5 text-xs text-text-muted">
                          Inactiva
                        </span>
                      )}
                      {rezagada && (
                        <span className="rounded-md bg-fc-bad-bg px-2 py-0.5 text-xs font-medium text-fc-bad-text">
                          {h === null ? 'Nunca sincronizada' : `Sin sincronizar hace ${Math.round(h)} h`}
                        </span>
                      )}
                      {s.cuentaStatus && s.cuentaStatus !== 'ACTIVE' && (
                        <span className="rounded-md bg-fc-bad-bg px-2 py-0.5 text-xs font-medium text-fc-bad-text">
                          Cuenta: {s.cuentaStatus}
                        </span>
                      )}
                    </div>
                    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                      <div className="flex gap-1">
                        <dt>Cuenta</dt>
                        <dd className="text-text-base">{s.cuenta}</dd>
                      </div>
                      <div className="flex gap-1">
                        <dt>Última exitosa</dt>
                        <dd className="text-text-base">
                          {e?.lastSuccessAt ? `${momento(e.lastSuccessAt)} (${hace(e.lastSuccessAt, ahoraMs)})` : 'nunca'}
                        </dd>
                      </div>
                      <div className="flex gap-1">
                        <dt>Checkpoint</dt>
                        <dd className="text-text-base">{momento(e?.lastSyncedAt ?? null)}</dd>
                      </div>
                      <div className="flex gap-1">
                        <dt>Histórico</dt>
                        <dd className="text-text-base">
                          {ETIQUETA_BACKFILL[e?.backfillStatus ?? 'PENDING'] ?? e?.backfillStatus}
                        </dd>
                      </div>
                      {(e?.consecutiveFailures ?? 0) > 0 && (
                        <div className="flex gap-1">
                          <dt>Fallos seguidos</dt>
                          <dd className="font-medium text-fc-bad-text">{e!.consecutiveFailures}</dd>
                        </div>
                      )}
                    </dl>
                  </div>

                  <div className="shrink-0">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setReparando(abierto ? null : s.storeId)}
                    >
                      {abierto ? 'Cancelar' : 'Re-sincronizar rango'}
                    </Button>
                  </div>
                </div>

                {/* El motivo del último fallo va completo y no truncado: es la
                    razón por la que alguien abre esta pantalla. */}
                {e?.lastRunStatus === 'ERROR' && e.lastRunError && (
                  <Alert tone="danger">
                    <strong>Última corrida con error:</strong> {e.lastRunError}
                  </Alert>
                )}

                {abierto && (
                  <div className="rounded-md border border-border-base bg-app p-3">
                    <p className="text-xs text-text-muted">
                      Vuelve a bajar los tickets <strong>creados</strong> en estos días, en la
                      zona de la sucursal ({s.timezone}). Repetir un rango ya sincronizado no
                      duplica nada, y esta corrida <strong>no mueve el checkpoint</strong>: es
                      una reparación hacia atrás, no un avance.
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <FieldWrap label="Desde" htmlFor={`desde-${s.storeId}`}>
                        <TextInput
                          id={`desde-${s.storeId}`} type="date" value={desde} max={hasta}
                          onChange={(ev) => setDesde(ev.target.value)}
                        />
                      </FieldWrap>
                      <FieldWrap label="Hasta" htmlFor={`hasta-${s.storeId}`}>
                        <TextInput
                          id={`hasta-${s.storeId}`} type="date" value={hasta} min={desde}
                          max={hoyIso()} onChange={(ev) => setHasta(ev.target.value)}
                        />
                      </FieldWrap>
                      <div className="flex items-end">
                        <Button
                          loading={enCurso}
                          onClick={() => void reparar(s.storeId)}
                        >
                          Re-sincronizar
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text-strong">
          Bitácora de corridas{' '}
          <span className="font-normal text-text-muted">(últimas {datos.corridas.length})</span>
        </h2>

        {datos.corridas.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-base px-4 py-6 text-center text-sm text-text-muted">
            Todavía no hay corridas registradas.
          </p>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-lg border border-border-base bg-surface lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-base text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-4 py-2 text-left font-medium">Inicio</th>
                    <th className="px-4 py-2 text-left font-medium">Sucursal</th>
                    <th className="px-4 py-2 text-left font-medium">Tipo</th>
                    <th className="px-4 py-2 text-right font-medium">Págs.</th>
                    <th className="px-4 py-2 text-right font-medium">Tickets</th>
                    <th className="px-4 py-2 text-right font-medium">Renglones</th>
                    <th className="px-4 py-2 text-left font-medium">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.corridas.map((c) => (
                    <tr key={c.id} className="border-b border-border-base last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 text-text-strong">
                        {momento(c.startedAt)}
                      </td>
                      <td className="px-4 py-2">{nombrePorSucursal.get(c.storeId) ?? c.storeId}</td>
                      <td className="px-4 py-2">
                        {ETIQUETA_TIPO[c.kind] ?? c.kind}
                        {c.triggeredBy && (
                          <span className="ml-1 text-xs text-text-muted">· a mano</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.pagesFetched}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.receiptsUpserted}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.linesUpserted}</td>
                      <td className="px-4 py-2">
                        {c.status === 'SUCCESS' ? (
                          <span className="text-success">Correcta</span>
                        ) : c.status === 'RUNNING' ? (
                          <span className="text-text-muted">En curso</span>
                        ) : (
                          <span className="text-danger" title={c.errorDetail ?? undefined}>
                            {c.errorCode ?? 'Error'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 lg:hidden">
              {datos.corridas.map((c) => (
                <div key={c.id} className="rounded-lg border border-border-base bg-surface p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium text-text-strong">
                      {nombrePorSucursal.get(c.storeId) ?? c.storeId}
                    </p>
                    <p className="text-xs text-text-muted">{momento(c.startedAt)}</p>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {ETIQUETA_TIPO[c.kind] ?? c.kind}
                    {c.triggeredBy && ' · a mano'} ·{' '}
                    {c.status === 'SUCCESS' ? (
                      <span className="text-success">correcta</span>
                    ) : c.status === 'RUNNING' ? (
                      'en curso'
                    ) : (
                      <span className="text-danger">{c.errorCode ?? 'error'}</span>
                    )}
                  </p>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs text-text-muted">
                    <div><dt>Págs.</dt><dd className="tabular-nums text-text-base">{c.pagesFetched}</dd></div>
                    <div><dt>Tickets</dt><dd className="tabular-nums text-text-base">{c.receiptsUpserted}</dd></div>
                    <div><dt>Renglones</dt><dd className="tabular-nums text-text-base">{c.linesUpserted}</dd></div>
                  </dl>
                  {c.errorDetail && (
                    <p className="mt-2 text-xs text-danger">{c.errorDetail}</p>
                  )}
                </div>
              ))}
            </div>

            <p className="text-xs text-text-muted">
              Una corrida con 0 tickets no es un fallo: significa que el proveedor no tenía nada
              nuevo en ese rango. Es la respuesta a “¿por qué hoy no entró nada?”.
            </p>
          </>
        )}
      </section>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
