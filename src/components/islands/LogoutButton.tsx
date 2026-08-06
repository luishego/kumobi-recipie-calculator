import { useState } from 'react';
import { signOut } from 'firebase/auth';
import { getFirebaseAuth } from '../../lib/firebase/client';

/** Logout: signOut del SDK cliente + borrar cookie de sesión → /login. */
export default function LogoutButton() {
  const [busy, setBusy] = useState(false);

  async function handleLogout() {
    setBusy(true);
    try {
      await signOut(getFirebaseAuth()).catch(() => {});
      await fetch('/api/session', { method: 'DELETE' });
    } finally {
      window.location.assign('/login');
    }
  }

  return (
    <button
      onClick={handleLogout}
      disabled={busy}
      className="w-full rounded-md border border-border-base bg-surface px-3 py-1.5 text-sm font-medium text-text-base hover:bg-app disabled:opacity-50"
    >
      {busy ? 'Saliendo…' : 'Salir'}
    </button>
  );
}
