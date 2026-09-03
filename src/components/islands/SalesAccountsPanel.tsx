// Cuentas de POS conectadas — épica 02, HU-06 y HU-07.
//
// El token se captura una vez y no vuelve nunca del servidor: de ahí en
// adelante solo se muestran sus últimos 4 caracteres.
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { FieldWrap, Select, TextInput } from '../ui/Field';
import { Alert } from '../ui/Alert';
import { Toast, type ToastState } from '../ui/Toast';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';

interface SyncState {
  lastSyncedAt: string | null;
  lastRunStatus: 'SUCCESS' | 'ERROR' | 'RUNNING' | null;
  lastRunError: string | null;
  consecutiveFailures: number;
  backfillStatus: 'PENDING' | 'RUNNING' | 'PAUSED_BUDGET' | 'COMPLETE' | 'FAILED';
}

interface Store {
  id: string;
  providerStoreId: string;
  name: string;
  timezone: string;
  active: boolean;
  sync: SyncState | null;
}

const BACKFILL: Record<SyncState['backfillStatus'], string> = {
  PENDING: 'Histórico sin descargar',
  RUNNING: 'Descargando histórico…',
  PAUSED_BUDGET: 'Pausado por presupuesto — continúa mañana',
  COMPLETE: 'Histórico completo',
  FAILED: 'Descarga interrumpida — se puede continuar',
};

function fechaCorta(iso: string | null): string {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

interface Account {
  id: string;
  alias: string;
  provider: string;
  tokenLast4: string;
  defaultTimezone: string;
  backfillMaxDays: number | null;
  status: 'ACTIVE' | 'INVALID_TOKEN' | 'DISABLED';
  lastValidatedAt: string | null;
  stores: Store[];
}

const ZONAS = [
  'America/Mexico_City',
  'America/Cancun',
  'America/Chihuahua',
  'America/Tijuana',
];

const schema = z.object({
  alias: z.string().trim().min(1, 'Ponle un nombre para identificarla.').max(80),
  token: z.string().trim().min(8, 'El token parece demasiado corto.'),
  defaultTimezone: z.string().min(1),
  historico: z.enum(['30', 'todo']),
});
type FormValues = z.infer<typeof schema>;

async function api(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data;
}

const ESTADOS: Record<Account['status'], { texto: string; clase: string }> = {
  ACTIVE: { texto: 'Activa', clase: 'bg-fc-good-bg text-fc-good-text' },
  INVALID_TOKEN: { texto: 'Requiere reconexión', clase: 'bg-fc-bad-bg text-fc-bad-text' },
  DISABLED: { texto: 'Desactivada', clase: 'bg-app text-text-muted' },
};

interface Cupo {
  limite: number;
  activas: number;
  disponibles: number;
}

export default function SalesAccountsPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cupo, setCupo] = useState<Cupo | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [modalAbierto, setModalAbierto] = useState(false);
  const [rotando, setRotando] = useState<Account | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga(null);
    try {
      const data = await api('/api/sales/accounts');
      setAccounts(data.accounts ?? []);
      setCupo(data.cupo ?? null);
    } catch (e) {
      setErrorCarga((e as Error).message);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { alias: '', token: '', defaultTimezone: ZONAS[0], historico: 'todo' },
  });

  const cerrarModal = () => {
    setModalAbierto(false);
    setRotando(null);
    setErrorForm(null);
    form.reset();
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setErrorForm(null);
    try {
      if (rotando) {
        await api(`/api/sales/accounts/${rotando.id}/token`, {
          method: 'PUT',
          body: JSON.stringify({ token: values.token }),
        });
        setToast({ message: 'Token actualizado. La cuenta volvió a quedar activa.', tone: 'success' });
      } else {
        const data = await api('/api/sales/accounts', {
          method: 'POST',
          body: JSON.stringify({
            alias: values.alias,
            token: values.token,
            defaultTimezone: values.defaultTimezone,
            backfillMaxDays: values.historico === 'todo' ? null : 30,
          }),
        });
        const sinCupo = (data.sinCupo ?? []) as string[];
        setToast({
          message: sinCupo.length
            ? `Cuenta conectada. ${sinCupo.length === 1 ? 'La sucursal' : 'Las sucursales'} ${sinCupo.join(', ')} quedó inactiva por falta de cupo.`
            : 'Cuenta conectada y sucursales detectadas.',
          tone: sinCupo.length ? 'danger' : 'success',
        });
      }
      cerrarModal();
      await cargar();
    } catch (e) {
      setErrorForm((e as Error).message);
    }
  });

  async function resincronizar(a: Account) {
    setOcupado(a.id);
    try {
      const data = await api(`/api/sales/accounts/${a.id}/stores`, { method: 'POST' });
      const sinCupo = (data.sinCupo ?? []) as string[];
      setToast({
        message: sinCupo.length
          ? `Sucursales actualizadas. ${sinCupo.join(', ')} sin cupo: ${sinCupo.length === 1 ? 'quedó inactiva' : 'quedaron inactivas'}.`
          : 'Sucursales actualizadas.',
        tone: sinCupo.length ? 'danger' : 'success',
      });
      await cargar();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'danger' });
      await cargar();
    } finally {
      setOcupado(null);
    }
  }

  async function descargarHistorico(a: Account) {
    setOcupado(a.id);
    try {
      const data = await api(`/api/sales/accounts/${a.id}/backfill`, { method: 'POST' });
      const r = (data.resultados ?? []) as Array<{
        nombre: string; outcome: string; receipts: number; error?: string;
      }>;
      const recibos = r.reduce((n, x) => n + (x.receipts ?? 0), 0);
      const fallo = r.find((x) => x.outcome === 'FAILED');
      const pausa = r.find((x) => x.outcome === 'PAUSED_BUDGET');

      if (fallo) {
        setToast({ message: `Descarga interrumpida: ${fallo.error ?? 'error del proveedor'}. Se puede continuar.`, tone: 'danger' });
      } else if (pausa) {
        setToast({ message: `${recibos} tickets. Pausado por presupuesto diario; continúa mañana o vuelve a pulsar.`, tone: 'success' });
      } else if (r.every((x) => x.outcome === 'ALREADY_COMPLETE')) {
        setToast({ message: 'El histórico ya estaba descargado.', tone: 'success' });
      } else {
        setToast({ message: `Histórico descargado: ${recibos} tickets.`, tone: 'success' });
      }
      await cargar();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setOcupado(null);
    }
  }

  async function sincronizarAhora(a: Account) {
    setOcupado(a.id);
    try {
      const data = await api(`/api/sales/accounts/${a.id}/sync`, { method: 'POST' });
      const r = (data.resultados ?? []) as Array<{
        nombre: string; outcome: string; receipts: number; error?: string;
      }>;
      const recibos = r.reduce((n, x) => n + (x.receipts ?? 0), 0);
      const fallo = r.find((x) => x.outcome === 'FAILED');
      const sinHistorico = r.every((x) => x.outcome === 'SKIPPED_SIN_BACKFILL');

      if (fallo) {
        setToast({ message: `Sincronización fallida: ${fallo.error ?? 'error del proveedor'}`, tone: 'danger' });
      } else if (sinHistorico) {
        setToast({ message: 'Primero hay que descargar el histórico.', tone: 'danger' });
      } else {
        // Cero tickets es un resultado correcto: significa que no hubo cambios.
        setToast({
          message: recibos === 0 ? 'Al día: sin cambios desde la última sincronización.' : `${recibos} tickets nuevos o modificados.`,
          tone: 'success',
        });
      }
      await cargar();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setOcupado(null);
    }
  }

  async function alternarSucursal(s: Store) {
    setOcupado(s.id);
    try {
      await api(`/api/sales/stores/${encodeURIComponent(s.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !s.active }),
      });
      await cargar();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setOcupado(null);
    }
  }

  if (cargando) return <TableSkeleton rows={3} cols={4} />;
  if (errorCarga) return <ErrorState message={errorCarga} onRetry={() => void cargar()} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-text-muted">
            Cuentas de punto de venta desde las que se descargan las ventas.
          </p>
          {cupo && (
            <p className="mt-0.5 text-xs text-text-muted">
              {cupo.activas} de {cupo.limite} sucursales activas
              {cupo.disponibles === 0 && ' · sin cupo para más'}
            </p>
          )}
        </div>
        <Button onClick={() => { setRotando(null); setModalAbierto(true); }}>
          Conectar cuenta
        </Button>
      </div>

      {cupo?.disponibles === 0 && (
        <Alert tone="warning">
          Se alcanzó el límite de {cupo.limite} sucursales activas. Las sucursales nuevas que se
          descubran quedarán inactivas —y por lo tanto sin sincronizar— hasta que desactives otra
          o se amplíe el límite. El tope existe para acotar el consumo de la base de datos.
        </Alert>
      )}

      {accounts.length === 0 ? (
        <EmptyState
          title="Todavía no hay cuentas conectadas"
          description="Conecta una cuenta de Loyverse para empezar a descargar sus ventas."
        />
      ) : (
        <ul className="space-y-4">
          {accounts.map((a) => {
            const estado = ESTADOS[a.status];
            return (
              <li key={a.id} className="rounded-lg border border-border-base bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-text-strong">{a.alias}</h3>
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${estado.clase}`}>
                        {estado.texto}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-muted">
                      {a.provider} · token ····{a.tokenLast4} · {a.defaultTimezone} ·{' '}
                      {a.backfillMaxDays === null
                        ? 'histórico completo'
                        : `histórico de ${a.backfillMaxDays} días`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      loading={ocupado === a.id}
                      disabled={a.status !== 'ACTIVE'}
                      onClick={() => void sincronizarAhora(a)}
                    >
                      Sincronizar ahora
                    </Button>
                    <Button
                      variant="secondary" size="sm"
                      loading={ocupado === a.id}
                      disabled={a.status !== 'ACTIVE'}
                      onClick={() => void descargarHistorico(a)}
                    >
                      Descargar histórico
                    </Button>
                    <Button
                      variant="secondary" size="sm"
                      loading={ocupado === a.id}
                      onClick={() => void resincronizar(a)}
                    >
                      Re-sincronizar sucursales
                    </Button>
                    <Button
                      variant={a.status === 'INVALID_TOKEN' ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => { setRotando(a); setModalAbierto(true); }}
                    >
                      {a.status === 'INVALID_TOKEN' ? 'Reconectar' : 'Rotar token'}
                    </Button>
                  </div>
                </div>

                {a.status === 'INVALID_TOKEN' && (
                  <div className="mt-3">
                    <Alert tone="danger">
                      Loyverse rechazó el token guardado. La sincronización de esta cuenta está
                      detenida hasta que captures uno nuevo; los tickets ya descargados y el punto
                      de avance se conservan.
                    </Alert>
                  </div>
                )}

                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                    Sucursales ({a.stores.length})
                  </h4>
                  {a.stores.length === 0 ? (
                    <p className="text-sm text-text-muted">
                      No se detectaron sucursales. Prueba re-sincronizar.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border-base rounded-md border border-border-base">
                      {a.stores.map((s) => (
                        <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-text-strong">{s.name}</p>
                            <p className="text-xs text-text-muted">
                              {s.timezone} · {s.sync ? BACKFILL[s.sync.backfillStatus] : BACKFILL.PENDING}
                              {' · última sincronización: '}
                              {fechaCorta(s.sync?.lastSyncedAt ?? null)}
                            </p>
                            {s.sync?.lastRunStatus === 'ERROR' && s.sync.lastRunError && (
                              <p className="mt-0.5 text-xs text-danger">
                                {s.sync.lastRunError}
                                {s.sync.consecutiveFailures > 1 &&
                                  ` (${s.sync.consecutiveFailures} fallos seguidos)`}
                              </p>
                            )}
                          </div>
                          <Button
                            variant="ghost" size="sm"
                            loading={ocupado === s.id}
                            onClick={() => void alternarSucursal(s)}
                          >
                            {s.active ? 'Activa' : 'Inactiva'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={modalAbierto}
        title={rotando ? `Rotar token · ${rotando.alias}` : 'Conectar cuenta de Loyverse'}
        onClose={cerrarModal}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={cerrarModal}>Cancelar</Button>
            <Button onClick={() => void onSubmit()} loading={form.formState.isSubmitting}>
              {rotando ? 'Guardar token' : 'Conectar'}
            </Button>
          </div>
        }
      >
        <form className="space-y-4" onSubmit={onSubmit}>
          {errorForm && <Alert tone="danger">{errorForm}</Alert>}

          {!rotando && (
            <FieldWrap label="Nombre" htmlFor="alias" required error={form.formState.errors.alias?.message}>
              <TextInput
                id="alias" placeholder="Kumobi Centro"
                invalid={!!form.formState.errors.alias}
                {...form.register('alias')}
              />
            </FieldWrap>
          )}

          <FieldWrap
            label="Token de acceso" htmlFor="token" required
            error={form.formState.errors.token?.message}
            hint="Se genera en el Back Office de Loyverse. Se guarda cifrado y no vuelve a mostrarse."
          >
            <TextInput
              id="token" type="password" autoComplete="off"
              invalid={!!form.formState.errors.token}
              {...form.register('token')}
            />
          </FieldWrap>

          {!rotando && (
            <>
              <FieldWrap
                label="Zona horaria de las sucursales" htmlFor="tz"
                hint="Define a qué día pertenece cada ticket. Se puede ajustar después por sucursal."
              >
                <Select id="tz" {...form.register('defaultTimezone')}>
                  {ZONAS.map((z) => <option key={z} value={z}>{z}</option>)}
                </Select>
              </FieldWrap>

              <FieldWrap
                label="Histórico a descargar" htmlFor="hist"
                hint="El histórico completo da más días con los que verificar que las cifras cuadran."
              >
                <Select id="hist" {...form.register('historico')}>
                  <option value="todo">Todo el histórico</option>
                  <option value="30">Últimos 30 días</option>
                </Select>
              </FieldWrap>
            </>
          )}
        </form>
      </Modal>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
