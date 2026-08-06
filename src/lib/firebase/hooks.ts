// Hooks compartidos de datos para las islas React.
import { useEffect, useState } from 'react';
import { collection, getDocs, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { getDb, getFirebaseAuth } from './client';
import { COLLECTIONS } from '../constants';
import type { Category, Ingredient, RecipeDocument, UnitConfig } from '../types';

/** Espera a que el SDK cliente confirme el usuario autenticado (persistencia local). */
export function useAuthReady(): { user: User | null; ready: boolean } {
  const [state, setState] = useState<{ user: User | null; ready: boolean }>({
    user: null,
    ready: false,
  });
  useEffect(() => {
    return onAuthStateChanged(getFirebaseAuth(), (user) =>
      setState({ user, ready: true }),
    );
  }, []);
  return state;
}

interface Catalogs {
  units: UnitConfig[];
  categories: Category[];
  loading: boolean;
  error: string | null;
}

/** Carga puntual de catálogos base (unidades + categorías). */
export function useCatalogs(enabled: boolean): Catalogs {
  const [state, setState] = useState<Catalogs>({
    units: [],
    categories: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const db = getDb();
        const [unitsSnap, catsSnap] = await Promise.all([
          getDocs(collection(db, COLLECTIONS.units)),
          getDocs(collection(db, COLLECTIONS.categories)),
        ]);
        if (cancelled) return;
        setState({
          units: unitsSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as UnitConfig),
          categories: catsSnap.docs.map(
            (d) => ({ id: d.id, ...d.data() }) as Category,
          ),
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[useCatalogs]', err);
        setState((s) => ({
          ...s,
          loading: false,
          error: 'No se pudieron cargar los catálogos base.',
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}

/** Suscripción en vivo a una colección tipada. Devuelve estado de carga/error. */
export function useCollection<T>(
  collectionName: string,
  enabled: boolean,
): { data: T[]; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    const unsub = onSnapshot(
      collection(getDb(), collectionName),
      (snap) => {
        setData(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T));
        setLoading(false);
      },
      (err) => {
        console.error(`[useCollection ${collectionName}]`, err);
        setError(
          err.code === 'permission-denied'
            ? 'No tienes permiso para ver estos datos.'
            : 'No se pudieron cargar los datos.',
        );
        setLoading(false);
      },
    );
    return unsub;
  }, [collectionName, enabled, nonce]);

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

export type { Ingredient, RecipeDocument };
