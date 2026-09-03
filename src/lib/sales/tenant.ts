// Resolución del inquilino de la sesión — épica 02 §5.8.
//
// El `tenantId` sale SIEMPRE de la sesión, nunca del request: si viniera del
// cuerpo o de la URL, cualquiera podría pedir los datos de otro cliente. Esta
// es la única puerta por la que se obtiene, y `createRepo` se niega a
// construirse sin él.

import type { SessionUser } from '../session';

/** Inquilino #1. Es el único que existe hoy. */
export const TENANT_KUMOBI = 'tnt_kumobi';

/**
 * PERIODO DE GRACIA — retirar después del 2026-10-01.
 *
 * Al desplegar la épica 02 hay cookies de sesión ya emitidas que no traen
 * `tenantId`, y usuarios cuyo Custom Claim todavía no se asignó. Rechazarlas
 * sacaría del panel a quien estuviera trabajando en ese momento, así que
 * durante la transición se asumen de Kumobi, que hoy es el único inquilino.
 *
 * Para retirarlo: poner esta bandera en `false`, verificar que todos los
 * usuarios tienen el claim (`npm run set-claim`), y luego borrar esta rama.
 * A partir de entonces, sesión sin inquilino = sin acceso a datos de ventas.
 */
const PERIODO_DE_GRACIA = true;

export class TenantMissingError extends Error {
  constructor() {
    super(
      'La sesión no tiene inquilino asignado. El usuario necesita el Custom Claim ' +
        '`tenantId` y volver a iniciar sesión.',
    );
    this.name = 'TenantMissingError';
  }
}

/**
 * Inquilino con el que operar, a partir del usuario de la sesión.
 *
 * Lanza si no hay forma de determinarlo: es preferible un error explícito a
 * consultar datos del inquilino equivocado.
 */
export function resolveTenantId(user: Pick<SessionUser, 'tenantId'> | null): string {
  if (user?.tenantId) return user.tenantId;
  if (PERIODO_DE_GRACIA) return TENANT_KUMOBI;
  throw new TenantMissingError();
}

/** ¿Esta sesión está apoyándose en el periodo de gracia? Útil para avisar en la UI. */
export function usandoPeriodoDeGracia(user: Pick<SessionUser, 'tenantId'> | null): boolean {
  return PERIODO_DE_GRACIA && !user?.tenantId;
}
