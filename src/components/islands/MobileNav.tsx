import { useEffect, useState } from 'react';
import LogoutButton from './LogoutButton';

interface NavItem {
  href: string;
  label: string;
}
interface Props {
  items: NavItem[];
  pathname: string;
  email: string;
  role: string;
}

/**
 * Navegación móvil (HU-01): botón hamburguesa + drawer off-canvas.
 * Solo se muestra en pantallas < lg (en desktop está el sidebar fijo).
 * Reproduce el contenido del sidebar: enlaces, perfil y logout.
 */
export default function MobileNav({ items, pathname, email, role }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  // Misma regla que el sidebar: gana el enlace más específico que cubre la
  // ruta, para que "/ventas" no se marque a la vez que "/ventas/mapeo".
  const cubre = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
  const hrefActivo = items
    .map((item) => item.href)
    .filter(cubre)
    .sort((a, b) => b.length - a.length)[0];
  const isActive = (href: string) => href === hrefActivo;
  const initials = (email || '?').slice(0, 2).toUpperCase();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir menú de navegación"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border-base bg-surface text-text-strong"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navegación"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[80%] flex-col border-r border-border-base bg-surface shadow-xl"
          >
            <div className="flex h-14 items-center justify-between border-b border-border-base px-5">
              <span className="text-lg font-semibold text-text-strong">Kumobi</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar menú"
                className="rounded p-1 text-lg leading-none text-text-muted hover:text-text-strong"
              >
                ✕
              </button>
            </div>

            <nav className="flex-1 space-y-1 p-3" aria-label="Navegación principal">
              {items.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={`flex items-center gap-2 rounded-md border-l-2 px-3 py-2 text-sm font-medium ${
                    isActive(item.href)
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-transparent text-text-base hover:bg-app'
                  }`}
                >
                  {item.label}
                </a>
              ))}
            </nav>

            <div className="border-t border-border-base p-3">
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary"
                  aria-hidden="true"
                >
                  {initials}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-strong">
                    {email || 'Usuario'}
                  </p>
                  <p className="text-xs capitalize text-text-muted">{role || 'sin rol'}</p>
                </div>
              </div>
              <LogoutButton />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
