// Reporte de conciliación — épica 02, HU-16 (la compuerta).
//
// Pone lado a lado lo que calculamos nosotros y lo que reporta Loyverse, por
// día y por campo. El reporte del Back Office se lee EN EL NAVEGADOR: no se
// guarda, porque su valor es ser una foto del momento en que se verifica.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';
import { formatMxn } from '../../lib/sales/money';
import type { DailyTotals } from '../../lib/sales/aggregate';
import {
  parseBackOfficeCsv, conciliar, ETIQUETAS, BackOfficeCsvError,
  type ResultadoConciliacion, type CampoConciliado,
} from '../../lib/sales/backOfficeCsv';

const CAMPOS = Object.keys(ETIQUETAS) as CampoConciliado[];

const plural = (n: number, singular: string, pluralForma: string) =>
  `${n} ${n === 1 ? singular : pluralForma}`;

export default function ConciliacionPanel() {
  const [dias, setDias] = useState<DailyTotals[]>([]);
  const [rango, setRango] = useState<{ desde: string; hasta: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);
  const [reporte, setReporte] = useState<ReturnType<typeof parseBackOfficeCsv> | null>(null);
  const [verTodos, setVerTodos] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga(null);
    try {
      const res = await fetch('/api/sales/conciliacion');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setDias(data.dias ?? []);
      setRango(data.rango ?? null);
    } catch (e) {
      setErrorCarga((e as Error).message);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const resultado: ResultadoConciliacion | null = useMemo(
    () => (reporte ? conciliar(dias, reporte) : null),
    [dias, reporte],
  );

  async function alSubir(e: React.ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    if (!archivo) return;
    setErrorArchivo(null);
    try {
      setReporte(parseBackOfficeCsv(await archivo.text()));
    } catch (err) {
      setReporte(null);
      setErrorArchivo(
        err instanceof BackOfficeCsvError ? err.message : 'No se pudo leer el archivo.',
      );
    }
  }

  if (cargando) return <TableSkeleton rows={4} cols={4} />;
  if (errorCarga) return <ErrorState message={errorCarga} onRetry={() => void cargar()} />;

  if (!dias.length) {
    return (
      <EmptyState
        title="Todavía no hay ventas sincronizadas"
        description="Descarga el histórico desde Cuentas de venta antes de conciliar."
      />
    );
  }

  const aMostrar = resultado
    ? verTodos
      ? resultado.dias.filter((d) => d.tickets !== 0 || !d.cuadra)
      : resultado.diasConDiferencia
    : [];

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border-base bg-surface p-4">
        <h2 className="text-sm font-medium text-text-strong">Cómo se verifica</h2>
        <p className="mt-1 text-sm text-text-muted">
          En Loyverse: <strong>Reportes → Ventas</strong>, resumen por día, con el rango{' '}
          {rango ? <strong>{rango.desde} a {rango.hasta}</strong> : 'del histórico'}, y exporta el
          CSV. Se compara aquí mismo, en tu navegador; el archivo no se guarda.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="file" accept=".csv,text/csv" onChange={alSubir}
            className="text-sm text-text-base file:mr-3 file:rounded-md file:border file:border-border-base file:bg-app file:px-3 file:py-1.5 file:text-sm file:text-text-strong"
          />
          {reporte && (
            <span className="text-xs text-text-muted">{reporte.length} días en el reporte</span>
          )}
        </div>
        {errorArchivo && (
          <div className="mt-3">
            <Alert tone="danger">{errorArchivo}</Alert>
          </div>
        )}
      </section>

      {!resultado ? (
        <EmptyState
          title="Sube el reporte del Back Office"
          description="Sin él solo tenemos un lado del cuadre, y comparar nuestros datos contra sí mismos no demuestra nada."
        />
      ) : (
        <>
          {/* Tres estados, no dos: "los números coinciden" y "está verificado"
              no son lo mismo. Un reporte con un rango corto puede cuadrar
              perfectamente y dejar días enteros sin mirar. */}
          {!resultado.cuadra ? (
            <Alert tone="danger">
              <strong>No cuadra.</strong> {resultado.diasConDiferencia.length} de{' '}
              {resultado.dias.length} días tienen alguna diferencia.
            </Alert>
          ) : resultado.verificacionCompleta ? (
            <Alert tone="success">
              <strong>Cuadra.</strong> Los seis campos coinciden en los {resultado.dias.length}{' '}
              días del reporte, y la cobertura de días es idéntica (
              {resultado.cobertura.nuestros} con actividad de cada lado). No queda nada sin
              verificar.
            </Alert>
          ) : (
            <Alert tone="warning">
              <strong>Cuadra en lo verificado, pero falta cubrir parte del periodo.</strong>{' '}
              Los seis campos coinciden en los {resultado.dias.length} días que trae el reporte;
              lo de abajo queda fuera de esa comprobación.
            </Alert>
          )}

          {resultado.fueraDeRango.length > 0 && (
            <Alert tone="warning">
              {plural(resultado.fueraDeRango.length, 'día', 'días')} con ventas que el reporte no
              cubre ({resultado.fueraDeRango[0]}
              {resultado.fueraDeRango.length > 1 && ` … ${resultado.fueraDeRango.at(-1)}`}).
              Vuelve a exportarlo con un rango que{' '}
              {resultado.fueraDeRango.length > 1 ? 'los incluya' : 'lo incluya'}: por ahora{' '}
              {resultado.fueraDeRango.length > 1 ? 'no se están verificando' : 'no se está verificando'}.
            </Alert>
          )}

          {(resultado.cobertura.soloNuestros.length > 0 ||
            resultado.cobertura.soloSuyos.length > 0) && (
            <Alert tone="warning">
              Cobertura distinta: {resultado.cobertura.nuestros} días con actividad de nuestro
              lado contra {resultado.cobertura.suyos} en Loyverse.
              {resultado.cobertura.soloNuestros.length > 0 &&
                ` ${plural(resultado.cobertura.soloNuestros.length, 'día', 'días')} con ventas solo de nuestro lado (${resultado.cobertura.soloNuestros.slice(0, 3).join(', ')}${resultado.cobertura.soloNuestros.length > 3 ? '…' : ''}).`}
              {resultado.cobertura.soloSuyos.length > 0 &&
                ` ${plural(resultado.cobertura.soloSuyos.length, 'día', 'días')} con ventas solo en Loyverse (${resultado.cobertura.soloSuyos.slice(0, 3).join(', ')}${resultado.cobertura.soloSuyos.length > 3 ? '…' : ''}).`}
            </Alert>
          )}

          <section className="overflow-x-auto rounded-lg border border-border-base bg-surface">
            <table className="w-full text-sm">
              <caption className="px-4 pt-4 text-left text-sm font-medium text-text-strong">
                Totales del periodo
              </caption>
              <thead>
                <tr className="border-b border-border-base text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-2 text-left font-medium">Campo</th>
                  <th className="px-4 py-2 text-right font-medium">Nosotros</th>
                  <th className="px-4 py-2 text-right font-medium">Loyverse</th>
                  <th className="px-4 py-2 text-right font-medium">Diferencia</th>
                </tr>
              </thead>
              <tbody>
                {CAMPOS.map((c) => {
                  const t = resultado.totales[c];
                  return (
                    <tr key={c} className="border-b border-border-base last:border-0">
                      <td className="px-4 py-2 text-text-strong">{ETIQUETAS[c]}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatMxn(t.nuestro)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatMxn(t.suyo)}</td>
                      <td
                        className={`px-4 py-2 text-right font-medium tabular-nums ${
                          t.diff === 0 ? 'text-success' : 'text-danger'
                        }`}
                      >
                        {formatMxn(t.diff)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-text-strong">
                {verTodos ? 'Todos los días con actividad' : 'Días con diferencia'}
              </h2>
              <Button variant="secondary" size="sm" onClick={() => setVerTodos((v) => !v)}>
                {verTodos ? 'Ver solo diferencias' : 'Ver todos los días'}
              </Button>
            </div>

            {aMostrar.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border-base px-4 py-6 text-center text-sm text-text-muted">
                Ningún día tiene diferencias.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border-base bg-surface">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-base text-xs uppercase tracking-wide text-text-muted">
                      <th className="px-4 py-2 text-left font-medium">Día</th>
                      <th className="px-4 py-2 text-right font-medium">Tickets</th>
                      {CAMPOS.map((c) => (
                        <th key={c} className="px-4 py-2 text-right font-medium">
                          {ETIQUETAS[c]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {aMostrar.map((d) => (
                      <tr
                        key={d.businessDate}
                        className={`border-b border-border-base last:border-0 ${
                          d.cuadra ? '' : 'bg-fc-bad-bg'
                        }`}
                      >
                        <td className="whitespace-nowrap px-4 py-2 text-text-strong">
                          {d.businessDate}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{d.tickets}</td>
                        {CAMPOS.map((c) => {
                          const v = d.campos[c];
                          return (
                            <td
                              key={c}
                              className={`px-4 py-2 text-right tabular-nums ${
                                v.diff === 0 ? '' : 'font-medium text-danger'
                              }`}
                              title={`Nosotros ${formatMxn(v.nuestro)} · Loyverse ${formatMxn(v.suyo)}`}
                            >
                              {v.diff === 0 ? formatMxn(v.nuestro) : formatMxn(v.diff)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-text-muted">
              En los días que cuadran se muestra el importe; en los que no, la diferencia.
              Pasa el cursor sobre una celda para ver ambos lados.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
