import { Suspense, lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ProtectedRoute from './components/auth/protected-route';
import { Progress } from './components/ui/progress';

const LoadingComponent = Progress as ComponentType<{ message: string }>;

const CustomSuspense = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation();
  const message = pathname.includes('/signin') ? 'Cargando acceso…' : 'Cargando Itako…';
  return <Suspense fallback={<LoadingComponent message={message} />}>{children}</Suspense>;
};

const lazyImport = <T extends ComponentType<unknown>>(
  importFn: () => Promise<{ default: T }>
): LazyExoticComponent<T> => lazy(importFn);

const SignIn = lazyImport(() => import('./pages/auth/signin'));
const ItakoApp = lazyImport(() => import('./pages/itako/app'));

const Protected = ({ children }: { children: ReactNode }) => (
  <ProtectedRoute>{children}</ProtectedRoute>
);

const AppRoutes = () => (
  <CustomSuspense>
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/home" element={<Protected><ItakoApp /></Protected>} />
      <Route path="/" element={<Navigate to="/signin" replace />} />
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  </CustomSuspense>
);

export default AppRoutes;
