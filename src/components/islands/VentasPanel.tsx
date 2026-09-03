// Resumen de ventas por día — épica 02, HU-17.
//
// Pensado para leerse de un vistazo, no para depurar: primero el total del
// periodo, después el día a día. Sin gráficas ni comparativos (épica 03).
//
// Se muestran las dos cifras porque significan cosas distintas y confundirlas
// es fácil: "ventas netas" es lo que se cobró, con IVA incluido, y es como lo
// reporta Loyverse; "sin impuestos" es el ingreso real y la base del Food Cost.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { FieldWrap, Select, TextInput } from '../ui/Field';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';
import { formatMxn } from '../../lib/sales/money';
import type { DailyTotals } from '../../lib/sales/aggregate';

interface Sucursal {
  id: string;
  name: string;
  active: boolean;
}

const hoy = () => new Date().toISOString().slice(0, 10);
const haceDias = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** "2026-08-30" → "sáb 30 ago". Sin `new Date(iso)` para no caer en UTC. */
function diaLegible(businessDate: string): string {
  const [a, m, d] = businessDate.split('-').map(Number);
  const fecha = new Date(a!, m! - 1, d!);
  return fecha.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function VentasPanel() {
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoy());
  const [sucursal, setSucursal] = useState('');
  const [dias, setDias] = useState<DailyTotals[]>([]);
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
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

          {/* Tabla en escritorio, tarjetas en móvil: la misma convención que el
              resto del panel, para que no haya scroll horizontal en el teléfono. */}
          <section className="hidden overflow-x-auto rounded-lg border border-border-base bg-surface lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-base text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-2 text-left font-medium">Día</th>
                  <th className="px-4 py-2 text-right font-medium">Tickets</th>
                  <th className="px-4 py-2 text-right font-medium">Ventas netas</th>
                  <th className="px-4 py-2 text-right font-medium">Sin impuestos</th>
                  <th className="px-4 py-2 text-right font-medium">Reembolsos</th>
                </tr>
              </thead>
              <tbody>
                {dias.map((d) => (
                  <tr key={d.businessDate} className="border-b border-border-base last:border-0">
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
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="space-y-3 lg:hidden">
            {dias.map((d) => (
              <div key={d.businessDate} className="rounded-lg border border-border-base bg-surface p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-text-strong">{diaLegible(d.businessDate)}</p>
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
              </div>
            ))}
          </section>

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
