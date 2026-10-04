import type { ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/auth-context';
import AppRoutes from './routes';
import { Toaster } from '@/components/ui/toaster';
import { ThemeProvider } from '@/components/theme-provider';
import { LocaleProvider } from '@/context/locale-context';

const LocaleBridge = ({ children }: { children: ReactNode }) => {
  const { activeLocation } = useAuth();
  return <LocaleProvider location={activeLocation}>{children}</LocaleProvider>;
};

const AuthWrapper = () => {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <AuthProvider onNavigate={(path) => navigate(path, { replace: true })} pathname={location.pathname}>
      <LocaleBridge>
        <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
          <AppRoutes />
          <Toaster />
        </ThemeProvider>
      </LocaleBridge>
    </AuthProvider>
  );
};

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/*" element={<AuthWrapper />} />
      </Routes>
    </Router>
  );
}
