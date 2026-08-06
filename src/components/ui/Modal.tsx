import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Modal centrado con trampa de foco básica, cierre con Esc y overlay. */
export function Modal({ open, title, onClose, children, footer }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Foco inicial dentro del panel.
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button',
    );
    first?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previousFocus.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-lg bg-surface shadow-lg sm:max-w-lg sm:rounded-lg"
      >
        <div className="flex items-center justify-between border-b border-border-base px-5 py-4">
          <h2 className="text-lg font-semibold text-text-strong">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-md p-1 text-text-muted hover:bg-app hover:text-text-strong"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border-base px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
