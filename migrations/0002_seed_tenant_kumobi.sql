-- ────────────────────────────────────────────────────────────────────────────
-- Semilla: inquilino #1 — Kumobi.
--
-- Idempotente (INSERT OR IGNORE): re-aplicarla no pisa datos ni falla.
-- El alta de inquilinos nuevos NO es autoservicio en esta etapa; la hace el
-- equipo, y cada uno entra con su propia migración de semilla o desde la UI de
-- superadmin cuando exista.
--
-- La cuenta de Loyverse NO se siembra aquí: lleva el token cifrado y se da de
-- alta desde la UI (HU-06), que es la que tiene la llave para cifrarlo.
-- ────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO tenants (
  id, name, slug, default_timezone, currency, status, created_at, updated_at
) VALUES (
  'tnt_kumobi',
  'Kumobi',
  'kumobi',
  'America/Mexico_City',
  'MXN',
  'ACTIVE',
  '2026-09-01T00:00:00.000Z',
  '2026-09-01T00:00:00.000Z'
);
