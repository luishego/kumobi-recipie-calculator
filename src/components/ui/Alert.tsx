import type { ReactNode } from 'react';

type Tone = 'danger' | 'warning' | 'info' | 'success';

const TONES: Record<Tone, { box: string; icon: string }> = {
  danger: { box: 'border-danger/30 bg-fc-bad-bg text-fc-bad-text', icon: '⚠' },
  warning: { box: 'border-warning/30 bg-fc-warn-bg text-fc-warn-text', icon: '⚠' },
  info: { box: 'border-info/30 bg-primary-soft text-info', icon: 'ℹ' },
  success: { box: 'border-success/30 bg-fc-good-bg text-fc-good-text', icon: '✓' },
};

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${t.box}`}
    >
      <span aria-hidden="true" className="mt-0.5">
        {t.icon}
      </span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

/** Etiqueta de "preview informativo" (info). Distingue estimado vs. oficial (§3.2). */
export function PreviewLabel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-info/30 bg-primary-soft px-3 py-2 text-sm text-info">
      <span aria-hidden="true">ℹ </span>
      {children}
    </div>
  );
}
