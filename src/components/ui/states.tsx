import type { ReactNode } from 'react';
import { Button } from './Button';

/** Skeleton de filas para tablas en carga. */
export function TableSkeleton({ rows = 4, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="animate-pulse divide-y divide-border-base rounded-lg border border-border-base bg-surface">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: cols }).map((__, c) => (
            <div
              key={c}
              className="h-3 rounded bg-border-base"
              style={{ width: `${100 / cols}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-base bg-surface px-6 py-12 text-center">
      <div
        className="flex h-10 w-10 items-center justify-center rounded-full bg-app text-text-muted"
        aria-hidden="true"
      >
        ∅
      </div>
      <div>
        <p className="text-sm font-medium text-text-strong">{title}</p>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-danger/30 bg-fc-bad-bg px-6 py-12 text-center">
      <p className="text-sm font-medium text-fc-bad-text">
        <span aria-hidden="true">⚠ </span>
        {message}
      </p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}
