import { useEffect } from 'react';

export interface ToastState {
  message: string;
  tone: 'success' | 'danger';
}

const TONES = {
  success: 'bg-success text-white',
  danger: 'bg-danger text-white',
} as const;

/** Toast no bloqueante, esquina inferior derecha, auto-oculta. */
export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 3500);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div
      role="status"
      className={`fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-md px-4 py-2 text-sm shadow-lg ${TONES[toast.tone]}`}
    >
      <span aria-hidden="true">{toast.tone === 'success' ? '✓' : '⚠'}</span>
      {toast.message}
    </div>
  );
}
