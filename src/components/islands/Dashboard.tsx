import { useMemo } from 'react';
import {
  useAuthReady,
  useCatalogs,
  useCollection,
} from '../../lib/firebase/hooks';
import { COLLECTIONS } from '../../lib/constants';
import type { RecipeDocument } from '../../lib/types';
import { formatMXN, formatPercent } from '../../lib/format';
import { foodCostLevel } from '../../lib/costing';
import { CategoryBadge, FoodCostBadge } from '../ui/Badge';
import { Alert } from '../ui/Alert';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';

export default function Dashboard() {
  const { ready } = useAuthReady();
  const catalogs = useCatalogs(ready);
  const { data: recipes, loading, error, reload } = useCollection<RecipeDocument>(
    COLLECTIONS.recipes,
    ready,
  );

  const catById = useMemo(
    () => new Map(catalogs.categories.map((c) => [c.id, c] as const)),
    [catalogs.categories],
  );

  // Solo platillos finales (isSubRecipe === false).
  const dishes = useMemo(
    () =>
      recipes
        .filter((r) => !r.isSubRecipe)
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [recipes],
  );

  const stats = useMemo(() => {
    const withFc = dishes.filter(
      (d) => typeof d.foodCostPercentage === 'number' && d.foodCostPercentage > 0,
    );
    const avgFc =
      withFc.length > 0
        ? withFc.reduce((s, d) => s + (d.foodCostPercentage ?? 0), 0) / withFc.length
        : null;
    const needRecalc = dishes.filter((d) => d.requiresRecalculation).length;
    return { active: dishes.length, avgFc, needRecalc };
  }, [dishes]);

  if (loading || catalogs.loading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg border border-border-base bg-surface"
            />
          ))}
        </div>
        <TableSkeleton />
      </div>
    );
  }
  if (error) {
    return <ErrorState message={error} onRetry={reload} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-text-strong">Dashboard</h1>

      {stats.needRecalc > 0 && (
        <Alert tone="warning">
          {stats.needRecalc}{' '}
          {stats.needRecalc === 1 ? 'platillo requiere' : 'platillos requieren'} recálculo
          por cambios de precio.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Platillos activos" value={String(stats.active)} />
        <KpiCard
          label="Food Cost promedio"
          value={stats.avgFc != null ? formatPercent(stats.avgFc) : '—'}
          tone={
            stats.avgFc != null ? (foodCostLevel(stats.avgFc) ?? undefined) : undefined
          }
        />
        <KpiCard
          label="Requieren recálculo"
          value={stats.needRecalc > 0 ? `⚠ ${stats.needRecalc}` : 'Todo al día'}
          warning={stats.needRecalc > 0}
        />
      </div>

      <h2 className="mt-2 text-base font-semibold text-text-strong">Platillos del menú</h2>

      {dishes.length === 0 ? (
        <EmptyState
          title="Aún no hay platillos en el menú"
          description="Crea un platillo final para verlo aquí."
          action={
            <a href="/recetas/nueva" className="text-primary hover:underline">
              Crear receta
            </a>
          }
        />
      ) : (
        <>
          {/* Desktop: tabla */}
          <div className="hidden overflow-x-auto rounded-lg border border-border-base bg-surface shadow-card lg:block">
            <table className="w-full text-sm">
              <thead className="bg-app text-left text-xs text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Platillo</th>
                  <th className="px-4 py-2 font-medium">Categoría</th>
                  <th className="px-4 py-2 text-right font-medium">Costo/porc.</th>
                  <th className="px-4 py-2 text-right font-medium">Precio</th>
                  <th className="px-4 py-2 font-medium">Food Cost</th>
                  <th className="px-4 py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {dishes.map((d) => (
                  <tr
                    key={d.id}
                    className={d.requiresRecalculation ? 'bg-fc-warn-bg/40' : 'hover:bg-app/60'}
                  >
                    <td className="px-4 py-2.5 font-medium text-text-strong">
                      {d.requiresRecalculation && (
                        <span
                          className="mr-1.5 text-warning"
                          title="Un insumo base cambió de precio; recostea este platillo"
                          aria-label="Requiere recálculo"
                        >
                          ⚠
                        </span>
                      )}
                      {d.name}
                    </td>
                    <td className="px-4 py-2.5">
                      <CategoryBadge category={catById.get(d.categoryId)} />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular">
                      {formatMXN(d.costPerYieldUnit)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular">
                      {d.targetSellingPrice != null ? formatMXN(d.targetSellingPrice) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <FoodCostBadge percentage={d.foodCostPercentage} showLabel={false} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <a
                        href={`/recetas/${d.id}`}
                        className="text-primary hover:underline"
                        aria-label={`Recostear ${d.name}`}
                      >
                        →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Móvil: tarjetas */}
          <div className="flex flex-col gap-3 lg:hidden">
            {dishes.map((d) => (
              <div
                key={d.id}
                className={`rounded-lg border p-4 shadow-card ${
                  d.requiresRecalculation
                    ? 'border-warning/40 bg-fc-warn-bg/40'
                    : 'border-border-base bg-surface'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-text-strong">
                      {d.requiresRecalculation && (
                        <span className="mr-1 text-warning" aria-label="Requiere recálculo">
                          ⚠
                        </span>
                      )}
                      {d.name}
                    </p>
                    <div className="mt-1">
                      <CategoryBadge category={catById.get(d.categoryId)} />
                    </div>
                  </div>
                  <a
                    href={`/recetas/${d.id}`}
                    className="shrink-0 text-primary hover:underline"
                    aria-label={`Recostear ${d.name}`}
                  >
                    →
                  </a>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-text-muted">Costo/porc.</dt>
                    <dd className="tabular font-medium text-text-strong">
                      {formatMXN(d.costPerYieldUnit)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">Precio</dt>
                    <dd className="tabular font-medium text-text-strong">
                      {d.targetSellingPrice != null ? formatMXN(d.targetSellingPrice) : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">Food Cost</dt>
                    <dd>
                      <FoodCostBadge percentage={d.foodCostPercentage} showLabel={false} />
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="text-xs text-text-muted">
        ⚠ = requiere recálculo · → = abrir receta para recostear
      </p>
    </div>
  );
}

function KpiCard({
  label,
  value,
  tone,
  warning,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
  warning?: boolean;
}) {
  const toneColor =
    tone === 'good'
      ? 'text-fc-good-text'
      : tone === 'warn'
        ? 'text-fc-warn-text'
        : tone === 'bad'
          ? 'text-fc-bad-text'
          : warning
            ? 'text-warning'
            : 'text-text-strong';
  return (
    <div className="rounded-lg border border-border-base bg-surface p-5 shadow-card">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`mt-2 text-3xl font-semibold tabular ${toneColor}`}>{value}</p>
    </div>
  );
}
