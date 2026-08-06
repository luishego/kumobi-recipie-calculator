import type { Category } from '../../lib/types';
import { foodCostLevel, FOOD_COST_LABEL } from '../../lib/costing';
import { formatPercent } from '../../lib/format';

/** Chip de categoría: punto en `hexColor` + nombre (texto siempre legible). */
export function CategoryBadge({ category }: { category?: Category }) {
  if (!category) {
    return <span className="text-xs text-text-muted">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface px-2 py-0.5 text-xs text-text-base">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: category.hexColor }}
        aria-hidden="true"
      />
      {category.name}
    </span>
  );
}

const FC_STYLES = {
  good: 'bg-fc-good-bg text-fc-good-text',
  warn: 'bg-fc-warn-bg text-fc-warn-text',
  bad: 'bg-fc-bad-bg text-fc-bad-text',
} as const;

const FC_DOT = {
  good: 'bg-fc-good-dot',
  warn: 'bg-fc-warn-dot',
  bad: 'bg-fc-bad-dot',
} as const;

/** Badge de semáforo Food Cost: punto + % + etiqueta textual. */
export function FoodCostBadge({
  percentage,
  showLabel = true,
}: {
  percentage: number | null | undefined;
  showLabel?: boolean;
}) {
  const level = foodCostLevel(percentage);
  if (!level) {
    return <span className="text-xs text-text-muted">—</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium tabular ${FC_STYLES[level]}`}
    >
      <span className={`h-2 w-2 rounded-full ${FC_DOT[level]}`} aria-hidden="true" />
      {formatPercent(percentage)}
      {showLabel && <span className="font-normal">· {FOOD_COST_LABEL[level]}</span>}
    </span>
  );
}
