import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center bg-slate-50 px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-[14px] bg-red-600 text-2xl font-extrabold text-white">I</div>
          <div className="text-2xl font-extrabold text-slate-900">Itako</div>
        </div>
        {children}
        <p className="mt-6 text-center text-xs text-slate-500">Sistema de ventas para la taquería</p>
      </div>
    </div>
  );
}
