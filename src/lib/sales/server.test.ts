// Traducción de fallos a respuestas HTTP — épica 02.
//
// Se prueba porque es el punto donde un mensaje accionable se puede perder sin
// que nada falle: el endpoint sigue respondiendo, solo que dice "Error interno
// del servidor" y quien lo lee se queda sin saber qué revisar.
import { describe, it, expect } from 'vitest';
import { errorResponse, HttpError } from './server';
import { SalesCryptoError } from './crypto';
import { SalesProviderError } from './provider';

async function leer(res: Response) {
  return { status: res.status, body: (await res.json()) as { error: string; code?: string } };
}

describe('errorResponse', () => {
  it('conserva estado, mensaje y código de un HttpError', async () => {
    const r = await leer(errorResponse(new HttpError(404, 'La sucursal no existe.', 'NO_STORE')));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('La sucursal no existe.');
    expect(r.body.code).toBe('NO_STORE');
  });

  it('DECRYPT_FAILED es 409 y llega con su mensaje, no aplanado', async () => {
    const r = await leer(
      errorResponse(
        new SalesCryptoError('DECRYPT_FAILED', 'No se pudo descifrar el token guardado.'),
      ),
    );
    // 409 y no 500: hay una acción concreta que lo resuelve.
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DECRYPT_FAILED');
    // Lo que importa de verdad: el mensaje sobrevive hasta la respuesta.
    expect(r.body.error).toContain('descifrar');
    expect(r.body.error).not.toBe('Error interno del servidor.');
  });

  it('BAD_KEY es 500 —es culpa nuestra— pero tampoco pierde el mensaje', async () => {
    const r = await leer(
      errorResponse(new SalesCryptoError('BAD_KEY', 'Falta SALES_TOKEN_KEY en el entorno.')),
    );
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('BAD_KEY');
    expect(r.body.error).toContain('SALES_TOKEN_KEY');
  });

  it('un fallo inesperado SÍ se aplana: no se filtra el interior al cliente', async () => {
    const r = await leer(errorResponse(new Error('SELECT * FROM sales_accounts falló en la fila 3')));
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('Error interno del servidor.');
    expect(r.body.error).not.toContain('sales_accounts');
  });

  it('los errores del proveedor siguen aplanándose aquí', async () => {
    // Los traduce cada endpoint con el contexto que tiene (marcar la cuenta,
    // detener la corrida); este catch-all no debe adelantarse a esa decisión.
    const r = await leer(errorResponse(new SalesProviderError('INVALID_TOKEN', 'token muerto')));
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('Error interno del servidor.');
  });
});
