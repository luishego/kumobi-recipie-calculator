import { formatMXN } from '../../lib/format';
import { FoodCostBadge } from '../ui/Badge';

interface Props {
  isSubRecipe: boolean;
  totalCost: number;
  costPerYieldUnit: number | null;
  foodCostPercentage: number | null;
  contributionMargin: number | null;
  complete: boolean;
}

/** Resumen financiero (sticky). Preview informativo; el backend confirma al guardar. */
export function RecipeSummary({
  isSubRecipe,
  totalCost,
  costPerYieldUnit,
  foodCostPercentage,
  contributionMargin,
  complete,
}: Props) {
  return (
    <aside className="rounded-lg border border-border-base bg-surface p-5 shadow-card lg:sticky lg:top-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        Resumen financiero
      </h2>

      <dl className="mt-4 space-y-3">
        <div>
          <dt className="text-xs text-text-muted">Costo total</dt>
          <dd className="text-2xl font-semibold text-text-strong tabular">
            {formatMXN(totalCost)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">
            Costo por {isSubRecipe ? 'unidad de rendimiento' : 'porción'}
          </dt>
          <dd className="text-xl font-semibold text-text-strong tabular">
            {costPerYieldUnit != null ? formatMXN(costPerYieldUnit) : '—'}
          </dd>
        </div>

        {!isSubRecipe && (
          <>
            <div className="border-t border-border-base pt-3">
              <dt className="text-xs text-text-muted">Food Cost</dt>
              <dd className="mt-1">
                {foodCostPercentage != null ? (
                  <FoodCostBadge percentage={foodCostPercentage} />
                ) : (
                  <span className="text-sm text-text-muted">
                    — (define precio de venta)
                  </span>
                )}
              </dd>
              <p className="mt-1 text-xs text-text-muted">objetivo &lt; 30%</p>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Margen de contribución</dt>
              <dd
                className={`text-xl font-semibold tabular ${
                  contributionMargin != null && contributionMargin < 0
                    ? 'text-danger'
                    : 'text-text-strong'
                }`}
              >
                {contributionMargin != null ? formatMXN(contributionMargin) : '—'}
              </dd>
              {contributionMargin != null && contributionMargin < 0 && (
                <p className="mt-1 text-xs font-medium text-danger">Se vende a pérdida</p>
              )}
            </div>
          </>
        )}
      </dl>

      <p className="mt-4 rounded-md bg-primary-soft px-3 py-2 text-xs text-info">
        <span aria-hidden="true">ℹ </span>
        {complete
          ? 'Cifras estimadas. Se confirman con el cálculo del backend al guardar.'
          : 'Completa los renglones para estimar el costo.'}
      </p>
    </aside>
  );
}
