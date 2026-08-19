import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { getFirebaseAuth } from '../../lib/firebase/client';
import { FieldWrap, TextInput } from '../ui/Field';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { Eye, EyeOff } from 'lucide-react';


const schema = z.object({
  email: z.string().min(1, 'Ingresa tu correo.').email('Correo no válido.'),
  password: z.string().min(1, 'Ingresa tu contraseña.'),
});
type FormValues = z.infer<typeof schema>;

/** Mapea errores de Firebase Auth a microcopy en español (sin exponer detalle técnico). */
function authErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
      case 'auth/invalid-email':
        return 'Correo o contraseña incorrectos.';
      case 'auth/user-disabled':
        return 'Esta cuenta está deshabilitada.';
      case 'auth/too-many-requests':
        return 'Demasiados intentos. Espera un momento e inténtalo de nuevo.';
      default:
        return 'No se pudo iniciar sesión. Inténtalo de nuevo.';
    }
  }
  return 'No se pudo iniciar sesión. Inténtalo de nuevo.';
}

export default function LoginForm() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      const cred = await signInWithEmailAndPassword(
        getFirebaseAuth(),
        values.email,
        values.password,
      );
      const idToken = await cred.user.getIdToken();

      // Intercambio idToken → session cookie (Admin SDK, endpoint server).
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        throw new Error('session-exchange-failed');
      }
      // Éxito → dashboard (recarga completa para que el middleware SSR valide).
      window.location.assign('/');
    } catch (err) {
      setServerError(authErrorMessage(err));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
      <FieldWrap label="Correo" htmlFor="email" required error={errors.email?.message}>
        <TextInput
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          placeholder="email@restaurante.mx"
          invalid={!!errors.email}
          {...register('email')}
        />
      </FieldWrap>

      <FieldWrap
        label="Contraseña"
        htmlFor="password"
        required
        error={errors.password?.message}
      >
        <div className="relative">
          <TextInput
            id="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="••••••••••"
            invalid={!!errors.password}
            {...register('password')}
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text-strong"
          >
            {showPassword ? <EyeOff size={24} color="gray" /> : <Eye size={24} color="black" />}
          </button>
        </div>
      </FieldWrap>

      {serverError && <Alert tone="danger">{serverError}</Alert>}

      <Button type="submit" loading={isSubmitting} className="w-full">
        {isSubmitting ? 'Ingresando…' : 'Iniciar sesión'}
      </Button>
    </form>
  );
}
