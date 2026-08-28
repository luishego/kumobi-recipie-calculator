import { useMemo, useState } from 'react';
import { deleteDoc, doc } from 'firebase/firestore';
import {
  useAuthReady,
  useCatalogs,
  useCollection,
} from '../../lib/firebase/hooks';
import { getDb } from '../../lib/firebase/client';
import { COLLECTIONS } from '../../lib/constants';
import type { Category, RecipeDocument } from '../../lib/types';
import { formatMXN } from '../../lib/format';
import { Button } from '../ui/Button';
import { CategoryBadge, FoodCostBadge } from '../ui/Badge';
import { Alert } from '../ui/Alert';
import { Toast, type ToastState } from '../ui/Toast';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';

type Filter = 'all' | 'dish' | 'sub';

export default function RecipesList() {
  const { ready } = useAuthReady();
  const catalogs = useCatalogs(ready);
  const { data, loading, error, reload } = useCollection<RecipeDocument>(
    COLLECTIONS.recipes,
    ready,
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [blockMsg, setBlockMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const catById = useMemo(
    () => new Map(catalogs.categories.map((c) => [c.id, c] as const)),
    [catalogs.categories],
  );

  // Integridad referencial: id de sub-receta → nombres de recetas que la usan.
  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of data) {
      for (const it of r.items ?? []) {
        if (it.type === 'RECETA') {
          const arr = m.get(it.refId) ?? [];
          arr.push(r.name);
          m.set(it.refId, arr);
        }
      }
    }
    return m;
  }, [data]);

  async function handleDelete(r: RecipeDocument) {
    const parents = usedBy.get(r.id) ?? [];
    if (parents.length > 0) {
      setBlockMsg(
        `No se puede eliminar "${r.name}": la usan como sub-receta ${parents.length} ` +
          `receta(s) — ${parents.join(', ')}. Quítala de esas recetas primero.`,
      );
      return;
    }
    if (!confirm(`¿Eliminar "${r.name}"? Esta acción no se puede deshacer.`)) return;
    setBlockMsg(null);
    try {
      await deleteDoc(doc(getDb(), COLLECTIONS.recipes, r.id));
      setToast({ message: 'Receta eliminada', tone: 'success' });
    } catch (err) {
      console.error('[RecipesList] eliminar', err);
      setToast({ message: 'No se pudo eliminar la receta.', tone: 'danger' });
    }
  }

  const rows = useMemo(() => {
    return data
      .filter((r) =>
        filter === 'all' ? true : filter === 'sub' ? r.isSubRecipe : !r.isSubRecipe,
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [data, filter]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-strong">Recetas</h1>
          <p className="text-sm text-text-muted">
            Sub-recetas base y platillos finales del menú.
          </p>
        </div>
        <a href="/recetas/nueva">
          <Button>+ Nueva receta</Button>
        </a>
      </div>

      <div className="flex gap-2" role="tablist" aria-label="Filtrar recetas">
        {(
          [
            ['all', 'Todas'],
            ['dish', 'Platillos'],
            ['sub', 'Sub-recetas'],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={filter === key}
            onClick={() => setFilter(key)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              filter === key
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border-base bg-surface text-text-base'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {blockMsg && (
        <div className="flex items-start justify-between gap-3">
          <Alert tone="danger">{blockMsg}</Alert>
          <button
            type="button"
            onClick={() => setBlockMsg(null)}
            className="mt-1 text-xs text-text-muted hover:text-text-strong"
            aria-label="Cerrar aviso"
          >
            ✕
          </button>
        </div>
      )}

      {loading || catalogs.loading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : data.length === 0 ? (
        <EmptyState
          title="Aún no hay recetas"
          description="Crea tu primera sub-receta o platillo del menú."
          action={
            <a href="/recetas/nueva">
              <Button>Nueva receta</Button>
            </a>
          }
        />
      ) : (
        <RecipeTable rows={rows} catById={catById} usedBy={usedBy} onDelete={handleDelete} />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function RecipeTable({
  rows,
  catById,
  usedBy,
  onDelete,
}: {
  rows: RecipeDocument[];
  catById: Map<string, Category>;
  usedBy: Map<string, string[]>;
  onDelete: (r: RecipeDocument) => void;
}) {
  return (
    <>
      {/* Desktop: tabla */}
      <div className="hidden overflow-x-auto rounded-lg border border-border-base bg-surface shadow-card lg:block">
        <table className="w-full text-sm">
          <thead className="bg-app text-left text-xs text-text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Receta</th>
              <th className="px-4 py-2 font-medium">Categoría</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 text-right font-medium">Costo/rend.</th>
              <th className="px-4 py-2 font-medium">Food Cost</th>
              <th className="px-4 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-base">
            {rows.map((r) => {
              const inUse = (usedBy.get(r.id) ?? []).length > 0;
              return (
                <tr key={r.id} className="hover:bg-app/60">
                  <td className="px-4 py-2.5 font-medium text-text-strong">
                    {r.name}
                    {r.requiresRecalculation && (
                      <span
                        className="ml-2 rounded bg-fc-warn-bg px-1.5 py-0.5 text-xs text-fc-warn-text"
                        title="Un insumo base cambió de precio; recostea este platillo"
                      >
                        ⚠ recálculo
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <CategoryBadge category={catById.get(r.categoryId)} />
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">
                    {r.isSubRecipe ? 'Sub-receta' : 'Platillo'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular">
                    {formatMXN(r.costPerYieldUnit)}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.isSubRecipe ? (
                      <span className="text-xs text-text-muted">—</span>
                    ) : (
                      <FoodCostBadge percentage={r.foodCostPercentage} showLabel={false} />
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <a
                        href={`/recetas/${r.id}`}
                        className="text-primary hover:underline"
                        aria-label={`Abrir ${r.name}`}
                      >
                        Abrir →
                      </a>
                      <button
                        type="button"
                        onClick={() => onDelete(r)}
                        className="text-text-muted hover:text-danger"
                        aria-label={`Eliminar ${r.name}`}
                        title={inUse ? 'En uso por otras recetas' : 'Eliminar'}
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Móvil: tarjetas */}
      <div className="flex flex-col gap-3 lg:hidden">
        {rows.map((r) => {
          const inUse = (usedBy.get(r.id) ?? []).length > 0;
          return (
            <div
              key={r.id}
              className="rounded-lg border border-border-base bg-surface p-4 shadow-card"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-text-strong">{r.name}</p>
                  {r.requiresRecalculation && (
                    <span className="mt-1 inline-block rounded bg-fc-warn-bg px-1.5 py-0.5 text-xs text-fc-warn-text">
                      ⚠ recálculo
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onDelete(r)}
                  className="shrink-0 text-text-muted hover:text-danger"
                  aria-label={`Eliminar ${r.name}`}
                  title={inUse ? 'En uso por otras recetas' : 'Eliminar'}
                >
                  🗑
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CategoryBadge category={catById.get(r.categoryId)} />
                <span className="text-xs text-text-muted">
                  {r.isSubRecipe ? 'Sub-receta' : 'Platillo'}
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-text-muted">Costo/rend.</dt>
                  <dd className="tabular font-medium text-text-strong">
                    {formatMXN(r.costPerYieldUnit)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-text-muted">Food Cost</dt>
                  <dd>
                    {r.isSubRecipe ? (
                      <span className="text-xs text-text-muted">—</span>
                    ) : (
                      <FoodCostBadge percentage={r.foodCostPercentage} showLabel={false} />
                    )}
                  </dd>
                </div>
              </dl>
              <a
                href={`/recetas/${r.id}`}
                className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
                aria-label={`Abrir ${r.name}`}
              >
                Abrir →
              </a>
            </div>
          );
        })}
      </div>
    </>
  );
}
