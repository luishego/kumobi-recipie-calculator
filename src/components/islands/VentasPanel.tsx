// Resumen de ventas por día — épica 02, HU-17.
//
// Pensado para leerse de un vistazo, no para depurar: primero el total del
// periodo, después el día a día. Al tocar un día se ven sus tickets.
//
// Se muestran las dos cifras porque significan cosas distintas y confundirlas
// es fácil: "ventas netas" es lo que se cobró, con IVA incluido, y es como lo
// reporta Loyverse; "sin impuestos" es el ingreso real y la base del Food Cost.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { FieldWrap, Select, TextInput } from '../ui/Field';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';
import { formatMxn } from '../../lib/sales/money';
import { haceDiasLocal, hoyLocal } from '../../lib/format';
import type { DailyTotals } from '../../lib/sales/aggregate';

interface Sucursal {
  id: string;
  name: string;
  active: boolean;
}

/** Un ticket del día (espejo de `ReceiptSummary` del repositorio). */
interface Recibo {
  id: string;
  receiptNumber: string;
  receiptType: 'SALE' | 'REFUND';
  totalCents: number;
  taxCents: number;
  tipCents: number;
  refundForReceiptNumber: string | null;
  diningOption: string | null;
  providerCreatedAt: string;
  storeId: string;
  storeName: string;
  storeTimezone: string;
}

type Orden = 'desc' | 'asc';

const hoy = hoyLocal;
const haceDias = haceDiasLocal;

/** "2026-08-30" → "sáb 30 ago". Sin `new Date(iso)` para no caer en UTC. */
function diaLegible(businessDate: string): string {
  const [a, m, d] = businessDate.split('-').map(Number);
  const fecha = new Date(a!, m! - 1, d!);
  return fecha.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Hora del ticket en la zona de SU sucursal (no la del navegador ni UTC). */
function horaLegible(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleTimeString('es-MX', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Importe con signo: un reembolso resta, como en los totales del día. */
function importeConSigno(r: Recibo): number {
  return r.receiptType === 'REFUND' ? -r.totalCents : r.totalCents;
}

export default function VentasPanel() {
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoy());
  const [sucursal, setSucursal] = useState('');
  const [orden, setOrden] = useState<Orden>('desc'); // más reciente primero
  const [dias, setDias] = useState<DailyTotals[]>([]);
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detalle del día seleccionado.
  const [diaSel, setDiaSel] = useState<string | null>(null);
  const [recibos, setRecibos] = useState<Recibo[]>([]);
  const [cargandoRecibos, setCargandoRecibos] = useState(false);
  const [errorRecibos, setErrorRecibos] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    // Al cambiar el filtro, el día abierto puede dejar de existir: se cierra.
    setDiaSel(null);
    setRecibos([]);
    try {
      const q = new URLSearchParams({ desde, hasta });
      if (sucursal) q.set('sucursal', sucursal);
      const res = await fetch(`/api/sales/ventas?${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setDias(data.dias ?? []);
      setSucursales(data.sucursales ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }, [desde, hasta, sucursal]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const abrirDia = useCallback(
    async (businessDate: string) => {
      if (diaSel === businessDate) {
        setDiaSel(null);
        setRecibos([]);
        return;
      }
      setDiaSel(businessDate);
      setRecibos([]);
      setErrorRecibos(null);
      setCargandoRecibos(true);
      try {
        const q = new URLSearchParams({ fecha: businessDate });
        if (sucursal) q.set('sucursal', sucursal);
        const res = await fetch(`/api/sales/recibos?${q}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
        setRecibos(data.recibos ?? []);
      } catch (e) {
        setErrorRecibos((e as Error).message);
      } finally {
        setCargandoRecibos(false);
      }
    },
    [diaSel, sucursal],
  );

  const resumen = useMemo(() => {
    const netas = dias.reduce((a, d) => a + d.netSalesCents, 0);
    const sinIva = dias.reduce((a, d) => a + d.netSalesExTaxCents, 0);
    const tickets = dias.reduce((a, d) => a + d.netTickets, 0);
    return {
      netas,
      sinIva,
      tickets,
      promedio: tickets > 0 ? Math.round(netas / tickets) : 0,
      diasConVenta: dias.filter((d) => d.netTickets !== 0).length,
    };
  }, [dias]);

  // El backend entrega los días en orden ascendente; aquí se aplica el orden
  // elegido sin volver a pedir datos.
  const diasOrdenados = useMemo(() => {
    const copia = [...dias];
    return orden === 'desc' ? copia.reverse() : copia;
  }, [dias, orden]);

  // Cuando hay más de una sucursal, la columna de sucursal del detalle importa.
  const variasSucursales = sucursales.length > 1;

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FieldWrap label="Desde" htmlFor="desde">
          <TextInput id="desde" type="date" value={desde} max={hasta}
            onChange={(e) => setDesde(e.target.value)} />
        </FieldWrap>
        <FieldWrap label="Hasta" htmlFor="hasta">
          <TextInput id="hasta" type="date" value={hasta} min={desde} max={hoy()}
            onChange={(e) => setHasta(e.target.value)} />
        </FieldWrap>
        <FieldWrap label="Sucursal" htmlFor="sucursal">
          <Select id="sucursal" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            <option value="">Todas</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.active ? '' : ' (inactiva)'}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <div className="flex items-end gap-2">
          <Button variant="secondary" onClick={() => { setDesde(haceDias(7)); setHasta(hoy()); }}>
            7 días
          </Button>
          <Button variant="secondary" onClick={() => { setDesde(haceDias(30)); setHasta(hoy()); }}>
            30 días
          </Button>
        </div>
      </section>

      {cargando ? (
        <TableSkeleton rows={5} cols={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void cargar()} />
      ) : dias.length === 0 ? (
        <EmptyState
          title="No hay ventas en este periodo"
          description="Prueba con otro rango de fechas, o revisa el estado de sincronización en Cuentas."
        />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { etiqueta: 'Ventas netas', valor: formatMxn(resumen.netas), nota: 'con impuestos' },
              { etiqueta: 'Sin impuestos', valor: formatMxn(resumen.sinIva), nota: 'base del Food Cost' },
              { etiqueta: 'Tickets', valor: String(resumen.tickets), nota: `${resumen.diasConVenta} días con venta` },
              { etiqueta: 'Ticket promedio', valor: formatMxn(resumen.promedio), nota: 'sobre tickets netos' },
            ].map((k) => (
              <div key={k.etiqueta} className="rounded-lg border border-border-base bg-surface p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {k.etiqueta}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-text-strong">
                  {k.valor}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">{k.nota}</p>
              </div>
            ))}
          </section>

          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-text-strong">Ventas por día</h2>
            <button
              type="button"
              onClick={() => setOrden((o) => (o === 'desc' ? 'asc' : 'desc'))}
              className="inline-flex items-center gap-1 rounded-md border border-border-base bg-surface px-3 py-1.5 text-xs font-medium text-text-base hover:bg-app"
              aria-label="Cambiar el orden de los días"
            >
              {orden === 'desc' ? 'Más reciente primero ↓' : 'Más antiguo primero ↑'}
            </button>
          </div>

          {/* Tabla en escritorio, tarjetas en móvil: la misma convención que el
              resto del panel, para que no haya scroll horizontal en el teléfono. */}
          <section className="hidden overflow-hidden rounded-lg border border-border-base bg-surface lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-base text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-2 text-left font-medium">Día</th>
                  <th className="px-4 py-2 text-right font-medium">Tickets</th>
                  <th className="px-4 py-2 text-right font-medium">Ventas netas</th>
                  <th className="px-4 py-2 text-right font-medium">Sin impuestos</th>
                  <th className="px-4 py-2 text-right font-medium">Reembolsos</th>
                  <th className="px-2 py-2" aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {diasOrdenados.map((d) => (
                  <tr
                    key={d.businessDate}
                    role="button"
                    tabIndex={0}
                    aria-expanded={diaSel === d.businessDate}
                    onClick={() => void abrirDia(d.businessDate)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void abrirDia(d.businessDate);
                      }
                    }}
                    className={`cursor-pointer border-b border-border-base last:border-0 ${
                      diaSel === d.businessDate ? 'bg-primary-soft' : 'hover:bg-app'
                    }`}
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-text-strong">
                      {diaLegible(d.businessDate)}
                      <span className="ml-2 text-xs text-text-muted">{d.businessDate}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{d.netTickets}</td>
                    <td
                      className={`px-4 py-2 text-right font-medium tabular-nums ${
                        d.netSalesCents < 0 ? 'text-danger' : 'text-text-strong'
                      }`}
                    >
                      {formatMxn(d.netSalesCents)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                      {formatMxn(d.netSalesExTaxCents)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                      {d.refundsCents > 0 ? formatMxn(d.refundsCents) : '—'}
                    </td>
                    <td className="px-2 py-2 text-right text-text-muted">
                      <span aria-hidden="true">{diaSel === d.businessDate ? '▾' : '▸'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="space-y-3 lg:hidden">
            {diasOrdenados.map((d) => (
              <button
                key={d.businessDate}
                type="button"
                onClick={() => void abrirDia(d.businessDate)}
                aria-expanded={diaSel === d.businessDate}
                className={`block w-full rounded-lg border p-4 text-left ${
                  diaSel === d.businessDate
                    ? 'border-primary bg-primary-soft'
                    : 'border-border-base bg-surface'
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-text-strong">
                    {diaLegible(d.businessDate)}
                    <span aria-hidden="true" className="ml-1 text-text-muted">
                      {diaSel === d.businessDate ? '▾' : '▸'}
                    </span>
                  </p>
                  <p
                    className={`text-lg font-semibold tabular-nums ${
                      d.netSalesCents < 0 ? 'text-danger' : 'text-text-strong'
                    }`}
                  >
                    {formatMxn(d.netSalesCents)}
                  </p>
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs text-text-muted">
                  <div><dt>Tickets</dt><dd className="tabular-nums text-text-base">{d.netTickets}</dd></div>
                  <div><dt>Sin imp.</dt><dd className="tabular-nums text-text-base">{formatMxn(d.netSalesExTaxCents)}</dd></div>
                  <div><dt>Reembolsos</dt><dd className="tabular-nums text-text-base">{d.refundsCents > 0 ? formatMxn(d.refundsCents) : '—'}</dd></div>
                </dl>
              </button>
            ))}
          </section>

          {diaSel && (
            <DetalleDia
              dia={diaSel}
              recibos={recibos}
              cargando={cargandoRecibos}
              error={errorRecibos}
              variasSucursales={variasSucursales}
              onCerrar={() => { setDiaSel(null); setRecibos([]); }}
              onReintentar={() => void abrirDia(diaSel)}
            />
          )}

          {dias.some((d) => d.netSalesCents < 0) && (
            <p className="text-xs text-text-muted">
              Un día en rojo tiene ventas netas negativas: hubo más reembolsos que ventas. Es
              correcto — el reembolso se registra el día en que se hizo, no el de la venta original.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function DetalleDia({
  dia,
  recibos,
  cargando,
  error,
  variasSucursales,
  onCerrar,
  onReintentar,
}: {
  dia: string;
  recibos: Recibo[];
  cargando: boolean;
  error: string | null;
  variasSucursales: boolean;
  onCerrar: () => void;
  onReintentar: () => void;
}) {
  return (
    <section className="rounded-lg border border-primary/40 bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border-base px-4 py-3">
        <h3 className="text-sm font-semibold text-text-strong">
          Tickets del {diaLegible(dia)}{' '}
          <span className="font-normal text-text-muted">· {dia}</span>
        </h3>
        <button
          type="button"
          onClick={onCerrar}
          className="rounded p-1 text-lg leading-none text-text-muted hover:text-text-strong"
          aria-label="Cerrar detalle del día"
        >
          ✕
        </button>
      </div>

      {cargando ? (
        <div className="p-4">
          <TableSkeleton rows={4} cols={4} />
        </div>
      ) : error ? (
        <div className="p-4">
          <ErrorState message={error} onRetry={onReintentar} />
        </div>
      ) : recibos.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-text-muted">
          No hay tickets para este día.
        </p>
      ) : (
        <>
          {/* Escritorio: tabla */}
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-base text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-2 text-left font-medium">Hora</th>
                  <th className="px-4 py-2 text-left font-medium">Ticket</th>
                  {variasSucursales && (
                    <th className="px-4 py-2 text-left font-medium">Sucursal</th>
                  )}
                  <th className="px-4 py-2 text-left font-medium">Tipo</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {recibos.map((r) => (
                  <tr key={r.id} className="border-b border-border-base last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-muted">
                      {horaLegible(r.providerCreatedAt, r.storeTimezone)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-text-strong">
                      {r.receiptNumber}
                      {r.receiptType === 'REFUND' && r.refundForReceiptNumber && (
                        <span className="ml-1 text-xs font-normal text-text-muted">
                          (de {r.refundForReceiptNumber})
                        </span>
                      )}
                    </td>
                    {variasSucursales && (
                      <td className="px-4 py-2 text-text-base">{r.storeName}</td>
                    )}
                    <td className="px-4 py-2">
                      <TipoBadge tipo={r.receiptType} />
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-medium tabular-nums ${
                        r.receiptType === 'REFUND' ? 'text-danger' : 'text-text-strong'
                      }`}
                    >
                      {formatMxn(importeConSigno(r))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Móvil: tarjetas */}
          <div className="space-y-2 p-3 lg:hidden">
            {recibos.map((r) => (
              <div
                key={r.id}
                className="rounded-md border border-border-base bg-app/40 p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-text-strong">
                    {r.receiptNumber}
                    <span className="ml-2 text-xs font-normal tabular-nums text-text-muted">
                      {horaLegible(r.providerCreatedAt, r.storeTimezone)}
                    </span>
                  </p>
                  <p
                    className={`text-sm font-semibold tabular-nums ${
                      r.receiptType === 'REFUND' ? 'text-danger' : 'text-text-strong'
                    }`}
                  >
                    {formatMxn(importeConSigno(r))}
                  </p>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <TipoBadge tipo={r.receiptType} />
                  <span>· {r.storeName}</span>
                  {r.receiptType === 'REFUND' && r.refundForReceiptNumber && (
                    <span>· de {r.refundForReceiptNumber}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function TipoBadge({ tipo }: { tipo: 'SALE' | 'REFUND' }) {
  return tipo === 'REFUND' ? (
    <span className="inline-block rounded bg-fc-bad-bg px-1.5 py-0.5 text-xs font-medium text-fc-bad-text">
      Reembolso
    </span>
  ) : (
    <span className="inline-block rounded bg-fc-good-bg px-1.5 py-0.5 text-xs font-medium text-fc-good-text">
      Venta
    </span>
  );
}
