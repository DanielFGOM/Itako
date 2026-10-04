import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useAuth } from '@/context/auth-context';
import { Mail, Lock, AlertCircle } from 'lucide-react';
import AuthLayout from './auth-layout';

interface FormData { email: string; password: string; }
interface FormErrors { email?: string; password?: string; submit?: string; }

const FIXED_EMAIL = 'Itakotaqueria@gmail.com';

export default function SignInPage() {
  const { signIn } = useAuth();
  const [errors, setErrors] = useState<FormErrors>({});
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<FormData>({ email: '', password: '' });

  const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(p => ({ ...p, [name]: value }));
    setErrors(p => ({ ...p, [name]: undefined, submit: undefined }));
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const next: FormErrors = {};
    if (!formData.email.trim()) next.email = 'Escribe tu correo.';
    if (!formData.password) next.password = 'Escribe tu contraseña.';
    if (formData.email.trim().toLowerCase() !== FIXED_EMAIL.toLowerCase()) next.email = 'El correo no corresponde al usuario de Itako.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setIsLoading(true);
    try { await signIn(formData.email.trim(), formData.password); }
    catch (err) { setErrors({ submit: err instanceof Error ? err.message : 'No se pudo iniciar sesión.' }); }
    finally { setIsLoading(false); }
  };

  return <AuthLayout>
    <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-xl">
      <h1 className="text-center text-2xl font-extrabold text-slate-900">Iniciar sesión</h1>
      <p className="mt-1 text-center text-sm text-slate-500">Ingresa para administrar Itako</p>
      {errors.submit && <div className="mt-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4"/><span>{errors.submit}</span></div>}
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <div>
          <label htmlFor="signin-email" className="mb-1.5 block text-sm font-bold text-slate-700">Correo</label>
          <div className="relative"><Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"/><input id="signin-email" name="email" type="email" autoComplete="email" value={formData.email} onChange={handleInput} disabled={isLoading} required className="w-full rounded-xl border border-slate-200 py-3 pl-10 pr-3 outline-none focus:border-red-300" placeholder="Itakotaqueria@gmail.com"/></div>
          {errors.email && <div className="mt-1 text-xs text-red-600">{errors.email}</div>}
        </div>
        <div>
          <label htmlFor="signin-password" className="mb-1.5 block text-sm font-bold text-slate-700">Contraseña</label>
          <div className="relative"><Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"/><input id="signin-password" name="password" type="password" autoComplete="current-password" value={formData.password} onChange={handleInput} disabled={isLoading} required className="w-full rounded-xl border border-slate-200 py-3 pl-10 pr-3 outline-none focus:border-red-300" placeholder="Contraseña"/></div>
          {errors.password && <div className="mt-1 text-xs text-red-600">{errors.password}</div>}
        </div>
        <button type="submit" disabled={isLoading} className="w-full rounded-xl bg-red-600 px-4 py-3 font-bold text-white disabled:opacity-50">{isLoading ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  </AuthLayout>;
}
