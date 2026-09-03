// Mapeo de ítems del POS ↔ recetas — épica 02, HU-11 (interfaz).
//
// Es la pantalla que une lo que se VENDIÓ (tickets en D1, épica 02) con lo que
// CUESTA (recetas en Firestore, épica 01). Sin ella los renglones están
// guardados pero mudos: el Food Cost real de la épica 03 no se puede calcular.
//
// ── Dos almacenes, una sola pantalla ────────────────────────────────────────
// Los ítems vendidos vienen del endpoint (D1, sesión por cookie httpOnly) y las
// recetas se leen AQUÍ con el SDK cliente de Firebase. Es la única frontera
// entre los dos almacenes y se cruza en el navegador porque es el único lugar
// donde hay sesión de los dos lados: el Worker no tiene credenciales de
// Firestore, y dárselas sería ampliar la superficie del servidor por una lectura.
//
// ── La regla que gobierna el diseño: no decidir en silencio ─────────────────
// Un mapeo mal hecho no se delata —produce un Food Cost plausible y falso—, así
// que aquí lo ambiguo se muestra como ambiguo, lo pendiente se cuenta EN PESOS
// y no en número de ítems, y el botón de confirmación en bloque solo alcanza a
// las propuestas con una sola candidata. Es la misma lógica de la compuerta
// HU-16: preferir un hueco visible a una cifra creíble.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthReady, useCollection } from '../../lib/firebase/hooks';
import { COLLECTIONS } from '../../lib/constants';
import type { RecipeDocument } from '../../lib/types';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { Combobox } from '../ui/Combobox';
import { FieldWrap, Select } from '../ui/Field';
import { Toast, type ToastState } from '../ui/Toast';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';
import { formatMxn } from '../../lib/sales/money';
// `cobertura` es una función pura y su propia documentación dice que se deriva
// "de la misma lista que ve la pantalla": se importa en vez de rehacerla aquí,
// porque dos cálculos que suman lo mismo por caminos distintos acaban
// divergiendo el día que alguien toca uno y no el otro.
import { cobertura, type MapeoItem, type PosItemVendido } from '../../lib/sales/repo/itemMap';
import { proponerMapeos, propuestasSeguras, type Propuesta } from '../../lib/sales/mapping/match';

interface Sucursal {
  id: string;
  name: string;
  active: boolean;
}

type Filtro = 'pendientes' | 'decididos' | 'todos';

const ETIQUETA_METODO: Record<MapeoItem['method'], string> = {
  auto_sku: 'por SKU',
  auto_name: 'por nombre',
  manual: 'a mano',
};

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Nombre completo del ítem tal como se lee en el POS. */
function nombreItem(item: PosItemVendido): string {
  return item.variantName ? `${item.itemName} · ${item.variantName}` : item.itemName;
}

export default function MapeoPanel() {
  // Las recetas necesitan sesión de Firebase confirmada; los ítems no, porque
  // van por cookie. Por eso son dos cargas independientes y no una sola.
  const { ready } = useAuthReady();
  const recetas = useCollection<RecipeDocument>(COLLECTIONS.recipes, ready);

  const [items, setItems] = useState<PosItemVendido[]>([]);
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [sucursal, setSucursal] = useState('');
  const [rango, setRango] = useState<{ desde: string; hasta: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filtro, setFiltro] = useState<Filtro>('pendientes');
  const [eligiendo, setEligiendo] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<ReadonlySet<string>>(new Set());
  const [confirmando, setConfirmando] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (sucursal) q.set('sucursal', sucursal);
      const qs = q.toString();
      const res = await fetch(qs ? `/api/sales/items?${qs}` : '/api/sales/items');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setItems(data.items ?? []);
      setSucursales(data.sucursales ?? []);
      setRango(data.rango ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }, [sucursal]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Las sub-recetas quedan fuera del selector: son insumos de otras recetas, no
  // productos que se vendan. `proponerMapeos` ya las descarta por su cuenta, así
  // que el filtro manual y el automático coinciden.
  const vendibles = useMemo(() => recetas.data.filter((r) => !r.isSubRecipe), [recetas.data]);

  // El índice va sobre TODAS las recetas, no solo las vendibles: si un mapeo
  // apunta a una receta que después se convirtió en sub-receta, hay que poder
  // mostrar su nombre para que se entienda qué corregir.
  const recetaPorId = useMemo(
    () => new Map(recetas.data.map((r) => [r.id, r] as const)),
    [recetas.data],
  );

  const propuestas = useMemo(() => proponerMapeos(items, recetas.data), [items, recetas.data]);
  const seguras = useMemo(() => propuestasSeguras(propuestas), [propuestas]);
  const ambiguos = useMemo(
    () => [...propuestas.values()].filter((p) => p.estado === 'AMBIGUO').length,
    [propuestas],
  );

  const cob = useMemo(() => cobertura(items), [items]);

  const visibles = useMemo(() => {
    if (filtro === 'todos') return items;
    return items.filter((i) => (filtro === 'decididos' ? i.mapeo !== null : i.mapeo === null));
  }, [items, filtro]);

  const marcar = useCallback((clave: string, activo: boolean) => {
    setGuardando((prev) => {
      const s = new Set(prev);
      if (activo) s.add(clave);
      else s.delete(clave);
      return s;
    });
  }, []);

  const aplicar = useCallback(
    (cambios: ReadonlyMap<string, MapeoItem | null>) =>
      setItems((prev) =>
        prev.map((i) => (cambios.has(i.clave) ? { ...i, mapeo: cambios.get(i.clave)! } : i)),
      ),
    [],
  );

  const opciones = useMemo(
    () => vendibles.map((r) => ({ value: r.id, label: r.name })),
    [vendibles],
  );

  async function guardar(
    item: PosItemVendido,
    kind: MapeoItem['kind'],
    recipeId: string | null,
    method: MapeoItem['method'],
  ) {
    if (!item.providerItemId) return;
    marcar(item.clave, true);
    try {
      const res = await fetch('/api/sales/item-map', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entradas: [
            {
              accountId: item.accountId,
              providerItemId: item.providerItemId,
              providerVariantId: item.providerVariantId ?? '',
              kind,
              recipeId,
              method,
            },
          ],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      // El servidor marca `confirmedByUser` en todo lo que entra por esta ruta:
      // si llegó hasta aquí es porque alguien lo decidió, venga de donde venga.
      aplicar(new Map([[item.clave, { kind, recipeId, method, confirmedByUser: true }]]));
      setEligiendo(null);
      setToast({
        message: kind === 'IGNORED' ? 'Marcado como "no aplica".' : 'Mapeo guardado.',
        tone: 'success',
      });
    } catch (e) {
      // Sin cambio local: la pantalla sigue mostrando el estado real de la base,
      // no el que se intentó guardar.
      setToast({ message: (e as Error).message, tone: 'danger' });
    } finally {
      marcar(item.clave, false);
    }
  }

  async function quitar(item: PosItemVendido) {
    marcar(item.clave, true);
    try {
      const res = await fetch('/api/sales/item-map', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clave: item.clave }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      aplicar(new Map([[item.clave, null]]));
      setToast({ message: 'Decisión retirada.', tone: 'success' });
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'danger' });
    } finally {
      marcar(item.clave, false);
    }
  }

  async function confirmarSeguras() {
    const porClave = new Map(items.map((i) => [i.clave, i] as const));
    const entradas = seguras.flatMap(({ clave, recipeId, method }) => {
      const it = porClave.get(clave);
      if (!it?.providerItemId) return [];
      return [
        {
          accountId: it.accountId,
          providerItemId: it.providerItemId,
          providerVariantId: it.providerVariantId ?? '',
          kind: 'RECIPE' as const,
          recipeId,
          method,
        },
      ];
    });
    if (entradas.length === 0) return;

    setConfirmando(true);
    try {
      const res = await fetch('/api/sales/item-map', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entradas }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      aplicar(
        new Map(
          seguras.map(({ clave, recipeId, method }) => [
            clave,
            { kind: 'RECIPE' as const, recipeId, method, confirmedByUser: true },
          ]),
        ),
      );
      setToast({
        message: `${plural(data.escritas ?? entradas.length, 'mapeo confirmado', 'mapeos confirmados')}.`,
        tone: 'success',
      });
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setConfirmando(false);
    }
  }

  if (cargando) return <TableSkeleton rows={6} cols={4} />;
  if (error) return <ErrorState message={error} onRetry={() => void cargar()} />;

  if (items.length === 0) {
    return (
      <EmptyState
        title="Todavía no hay ítems vendidos"
        description="El mapeo se arma sobre lo que ya se sincronizó. Descarga el histórico desde Cuentas de venta y vuelve aquí."
      />
    );
  }

  const pct = cob.fraccionDecidida === null ? null : Math.round(cob.fraccionDecidida * 100);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border-base bg-surface p-4">
        <h2 className="text-sm font-medium text-text-strong">Qué se decide aquí</h2>
        <p className="mt-1 text-sm text-text-muted">
          Cada ítem que se vende en el POS necesita apuntar a una receta para poder comparar su
          costo teórico contra lo que realmente salió de la cocina. Lo que no corresponda a una
          receta —una propina, un producto de reventa— se marca <strong>“no aplica”</strong>: es
          una decisión, no un olvido, y por eso cuenta como cubierto.
        </p>
        <p className="mt-2 text-xs text-text-muted">
          Sobre el histórico completo
          {rango && (
            <>
              {' '}
              (<strong>{rango.desde}</strong> a <strong>{rango.hasta}</strong>)
            </>
          )}
          . El mapeo se aplica en la consulta: corregirlo más tarde no obliga a volver a descargar
          nada.
        </p>
        {sucursales.length > 1 && (
          <div className="mt-3 max-w-xs">
            <FieldWrap label="Sucursal" htmlFor="sucursal">
              <Select id="sucursal" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
                <option value="">Todas</option>
                {sucursales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.active ? '' : ' (inactiva)'}
                  </option>
                ))}
              </Select>
            </FieldWrap>
          </div>
        )}
      </section>

      {/* La cobertura se mide EN PESOS, no en número de ítems: veinte ítems sin
          mapear que casi no se venden importan mucho menos que uno solo que es
          la mitad de la carta. */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            etiqueta: 'Cobertura',
            valor: pct === null ? '—' : `${pct}%`,
            nota: 'del ingreso ya decidido',
          },
          {
            etiqueta: 'Sin decidir',
            valor: formatMxn(cob.sinMapearCents),
            nota: plural(cob.itemsSinMapear, 'ítem', 'ítems'),
          },
          {
            etiqueta: 'Con receta',
            valor: formatMxn(cob.mapeadoCents),
            nota: plural(cob.itemsMapeados, 'ítem', 'ítems'),
          },
          {
            etiqueta: 'No aplica',
            valor: formatMxn(cob.ignoradoCents),
            nota: plural(cob.itemsIgnorados, 'ítem', 'ítems'),
          },
        ].map((k) => (
          <div key={k.etiqueta} className="rounded-lg border border-border-base bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
              {k.etiqueta}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-text-strong">{k.valor}</p>
            <p className="mt-0.5 text-xs text-text-muted">{k.nota}</p>
          </div>
        ))}
      </section>

      {recetas.error && <Alert tone="danger">{recetas.error}</Alert>}

      {!recetas.loading && !recetas.error && vendibles.length === 0 && (
        <Alert tone="warning">
          No hay recetas vendibles en el catálogo, así que no hay a qué mapear. Crea primero las
          recetas de los platillos: las sub-recetas no cuentan, son insumos de otras recetas.
        </Alert>
      )}

      {cob.itemsNoMapeables > 0 && (
        <Alert tone="info">
          {plural(cob.itemsNoMapeables, 'ítem vendido', 'ítems vendidos')} sin id de producto en el
          POS (ventas abiertas, capturadas con precio libre). No son mapeables desde aquí: para
          serlo tienen que venderse como producto del catálogo de Loyverse.
        </Alert>
      )}

      {(seguras.length > 0 || ambiguos > 0) && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-base bg-surface p-4">
          <div className="text-sm">
            {seguras.length > 0 ? (
              <p className="text-text-strong">
                <strong>{plural(seguras.length, 'propuesta', 'propuestas')}</strong> con una sola
                receta candidata.
              </p>
            ) : (
              <p className="text-text-strong">No hay propuestas confirmables en bloque.</p>
            )}
            {ambiguos > 0 && (
              <p className="mt-0.5 text-text-muted">
                {plural(ambiguos, 'ítem empata', 'ítems empatan')} con varias recetas y{' '}
                {ambiguos === 1 ? 'queda' : 'quedan'} fuera de la confirmación en bloque:{' '}
                {ambiguos === 1 ? 'hay que elegirla' : 'hay que elegirlas'} abajo.
              </p>
            )}
          </div>
          {seguras.length > 0 && (
            <Button onClick={() => void confirmarSeguras()} loading={confirmando}>
              Confirmar {seguras.length}
            </Button>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-text-strong">
            {filtro === 'pendientes'
              ? 'Ítems sin decidir'
              : filtro === 'decididos'
                ? 'Ítems ya decididos'
                : 'Todos los ítems vendidos'}{' '}
            <span className="font-normal text-text-muted">({visibles.length})</span>
          </h2>
          <div className="flex gap-2">
            {(
              [
                ['pendientes', 'Sin decidir'],
                ['decididos', 'Decididos'],
                ['todos', 'Todos'],
              ] as const
            ).map(([valor, etiqueta]) => (
              <Button
                key={valor}
                size="sm"
                variant={filtro === valor ? 'primary' : 'secondary'}
                onClick={() => setFiltro(valor)}
              >
                {etiqueta}
              </Button>
            ))}
          </div>
        </div>

        {visibles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-base px-4 py-6 text-center text-sm text-text-muted">
            {filtro === 'pendientes'
              ? 'No queda ningún ítem sin decidir: el Food Cost real se puede calcular sobre todo el ingreso.'
              : 'Nada que mostrar con este filtro.'}
          </p>
        ) : (
          <ul className="divide-y divide-border-base rounded-lg border border-border-base bg-surface">
            {visibles.map((item) => (
              <FilaItem
                key={item.clave}
                item={item}
                propuesta={propuestas.get(item.clave)}
                recetaPorId={recetaPorId}
                opciones={opciones}
                cargandoRecetas={recetas.loading}
                guardando={guardando.has(item.clave)}
                abierto={eligiendo === item.clave}
                onAbrir={(v) => setEligiendo(v ? item.clave : null)}
                onGuardar={(kind, recipeId, method) => void guardar(item, kind, recipeId, method)}
                onQuitar={() => void quitar(item)}
              />
            ))}
          </ul>
        )}
      </section>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

interface FilaProps {
  item: PosItemVendido;
  propuesta: Propuesta | undefined;
  recetaPorId: ReadonlyMap<string, RecipeDocument>;
  opciones: { value: string; label: string }[];
  guardando: boolean;
  abierto: boolean;
  onAbrir: (v: boolean) => void;
  onGuardar: (
    kind: MapeoItem['kind'],
    recipeId: string | null,
    method: MapeoItem['method'],
  ) => void;
  onQuitar: () => void;
}

function FilaItem({
  cargandoRecetas,
  ...props
}: FilaProps & { cargandoRecetas: boolean }) {
  const { item } = props;
  const mapeable = !!item.providerItemId;

  return (
    <li className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 lg:flex-1">
        <p className="text-sm font-medium text-text-strong">{nombreItem(item)}</p>
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
          {item.sku && (
            <div className="flex gap-1">
              <dt>SKU</dt>
              <dd className="tabular-nums text-text-base">{item.sku}</dd>
            </div>
          )}
          <div className="flex gap-1">
            <dt>Unidades</dt>
            <dd className="tabular-nums text-text-base">{item.unitsSold}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Ingreso</dt>
            <dd className="tabular-nums text-text-base">{formatMxn(item.revenueCents)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Última venta</dt>
            <dd className="tabular-nums text-text-base">{item.lastSoldDate}</dd>
          </div>
        </dl>
      </div>

      <div className="lg:w-[26rem] lg:shrink-0">
        {!mapeable ? (
          <p className="text-xs text-text-muted">
            Venta abierta del POS, sin producto de catálogo: no es mapeable.
          </p>
        ) : cargandoRecetas ? (
          <p className="text-xs text-text-muted">Cargando recetas…</p>
        ) : (
          <Control {...props} />
        )}
      </div>
    </li>
  );
}

function Control({
  item,
  propuesta,
  recetaPorId,
  opciones,
  guardando,
  abierto,
  onAbrir,
  onGuardar,
  onQuitar,
}: FilaProps) {
  const buscador = (
    <Combobox
      options={opciones}
      placeholder="Buscar receta…"
      disabled={guardando}
      onSelect={(o) => onGuardar('RECIPE', o.value, 'manual')}
    />
  );

  const noAplica = (
    <Button
      size="sm"
      variant="ghost"
      disabled={guardando}
      onClick={() => onGuardar('IGNORED', null, 'manual')}
    >
      No aplica
    </Button>
  );

  // ── Ya decidido ───────────────────────────────────────────────────────────
  if (item.mapeo) {
    const { kind, recipeId, method, confirmedByUser } = item.mapeo;
    const receta = recipeId ? recetaPorId.get(recipeId) : undefined;

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {kind === 'IGNORED' ? (
            <span className="rounded-md bg-app px-2 py-1 text-xs font-medium text-text-muted">
              No aplica
            </span>
          ) : receta ? (
            <span className="rounded-md bg-fc-good-bg px-2 py-1 text-xs font-medium text-fc-good-text">
              {receta.name}
              {receta.isSubRecipe && ' (sub-receta)'}
            </span>
          ) : (
            // El endpoint no valida el `recipe_id` contra Firestore a propósito
            // (no tiene credenciales). Este es el caso que eso deja abierto, y
            // se muestra en vez de dejar un mapeo apuntando a la nada.
            <span className="rounded-md bg-fc-bad-bg px-2 py-1 text-xs font-medium text-fc-bad-text">
              Receta no encontrada
            </span>
          )}
          <span className="text-xs text-text-muted">
            {ETIQUETA_METODO[method]}
            {confirmedByUser ? '' : ', sin confirmar'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={guardando}
            onClick={() => onAbrir(!abierto)}
          >
            {abierto ? 'Cancelar' : 'Cambiar'}
          </Button>
          <Button size="sm" variant="ghost" loading={guardando} onClick={onQuitar}>
            Quitar
          </Button>
        </div>
        {abierto && buscador}
      </div>
    );
  }

  // ── Sin decidir: manda la propuesta automática ────────────────────────────
  if (propuesta?.estado === 'PROPUESTO') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-text-muted">
          Propuesta {ETIQUETA_METODO[propuesta.method]}:{' '}
          <strong className="text-text-strong">{propuesta.recipeName}</strong>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={guardando}
            onClick={() => onGuardar('RECIPE', propuesta.recipeId, propuesta.method)}
          >
            Aceptar
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={guardando}
            onClick={() => onAbrir(!abierto)}
          >
            {abierto ? 'Cancelar' : 'Elegir otra'}
          </Button>
          {noAplica}
        </div>
        {abierto && buscador}
      </div>
    );
  }

  if (propuesta?.estado === 'AMBIGUO') {
    // Nunca se resuelve sola: si el sistema eligiera una de las dos en silencio,
    // el Food Cost saldría mal y se vería perfectamente bien.
    return (
      <div className="space-y-2">
        <p className="text-xs text-fc-warn-text">
          Empata {ETIQUETA_METODO[propuesta.method]} con{' '}
          {plural(propuesta.candidatos.length, 'receta', 'recetas')}. Elige cuál.
        </p>
        <Select
          aria-label={`Receta para ${nombreItem(item)}`}
          value=""
          disabled={guardando}
          onChange={(e) => {
            if (e.target.value) onGuardar('RECIPE', e.target.value, propuesta.method);
          }}
        >
          <option value="">Elegir receta…</option>
          {propuesta.candidatos.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={guardando}
            onClick={() => onAbrir(!abierto)}
          >
            {abierto ? 'Cancelar' : 'Buscar otra'}
          </Button>
          {noAplica}
        </div>
        {abierto && buscador}
      </div>
    );
  }

  // SIN_CANDIDATO, o todavía sin propuesta calculada.
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">Ninguna receta coincide por SKU ni por nombre.</p>
      {buscador}
      <div className="flex flex-wrap gap-2">{noAplica}</div>
    </div>
  );
}
