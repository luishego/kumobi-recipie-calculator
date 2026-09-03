-- ────────────────────────────────────────────────────────────────────────────
-- Los ids de sucursal usaban "::" como separador. Ese id viaja en la ruta de
-- `PATCH /api/sales/stores/:id`, y como Astro no decodifica los parámetros de
-- ruta, llegaba como "%3A%3A" y nunca coincidía: la UI respondía
-- "La sucursal no existe" al activar o desactivar una sucursal.
--
-- Se cambia a ".", que no es un carácter reservado en URLs.
--
-- SEGURO DE APLICAR AHORA porque todavía no hay tickets: `sales_receipts` y
-- `sync_state` referencian `sales_stores(id)`, y con claves foráneas activas
-- esta actualización fallaría si existieran filas hijas. Las tres sentencias
-- siguientes las cubren de todos modos, por si se aplicara en un entorno que
-- ya tenga datos.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE sales_receipt_lines SET store_id = REPLACE(store_id, '::', '.') WHERE store_id LIKE '%::%';
UPDATE sales_receipts      SET store_id = REPLACE(store_id, '::', '.') WHERE store_id LIKE '%::%';
UPDATE sync_state          SET store_id = REPLACE(store_id, '::', '.') WHERE store_id LIKE '%::%';
UPDATE sales_stores        SET id       = REPLACE(id,       '::', '.') WHERE id       LIKE '%::%';
