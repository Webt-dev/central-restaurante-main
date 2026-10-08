import { lazy, Suspense, useState, useEffect, Component, type ErrorInfo, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { ChangePasswordScreen } from './components/ChangePasswordScreen';
import { LicenseBanner } from './components/LicenseBanner';
import { RefreshCw } from 'lucide-react';
import { socket } from './services/socket';
import { loadSettings } from './services/settings';
import { useSession, canAccess, homeFor, type UserRole } from './services/session';

// Cada tela vira um pedacinho separado do código: o celular do garçom não baixa o painel
// do administrador, e a primeira abertura fica bem mais rápida em aparelho fraco.
const WaiterScreen = lazy(() => import('./components/WaiterScreen').then(m => ({ default: m.WaiterScreen })));
const KitchenScreen = lazy(() => import('./components/KitchenScreen').then(m => ({ default: m.KitchenScreen })));
const CashierScreen = lazy(() => import('./components/CashierScreen').then(m => ({ default: m.CashierScreen })));
const ReportsStockScreen = lazy(() => import('./components/ReportsStockScreen').then(m => ({ default: m.ReportsStockScreen })));
const AdminScreen = lazy(() => import('./components/AdminScreen').then(m => ({ default: m.AdminScreen })));
const FiscalScreen = lazy(() => import('./components/FiscalScreen').then(m => ({ default: m.FiscalScreen })));

/** Mostrado enquanto o pedaço da tela carrega (no modo leve vira só o texto, sem animação). */
function ScreenFallback() {
  return (
    <div className="page screen-loading" role="status" aria-live="polite">
      <RefreshCw size={22} className="spin" aria-hidden="true" />
      <span>Carregando...</span>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Erro não tratado:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div className="card card-pad" style={{ maxWidth: '460px', textAlign: 'center' }}>
            <h2 style={{ marginBottom: '8px' }}>Não foi possível carregar a tela</h2>
            <p className="hint" style={{ marginBottom: '18px' }}>
              {this.state.error?.message || 'Ocorreu um erro inesperado.'}
            </p>
            <button onClick={() => window.location.reload()} className="btn btn-primary btn-block">
              Recarregar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Só renderiza a tela se o papel do usuário puder abri-la; senão manda para a tela inicial dele. */
function Guard({ role, path, children }: { role: UserRole; path: string; children: ReactNode }) {
  return canAccess(role, path) ? <>{children}</> : <Navigate to={homeFor(role)} replace />;
}

export function AppContent() {
  const session = useSession();
  if (!session) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-main)' }}>
        <LoginScreen />
      </div>
    );
  }
  if (session.mustChangePassword) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-main)' }}>
        <ChangePasswordScreen />
      </div>
    );
  }
  return <AuthenticatedApp role={session.user.role} />;
}

function AuthenticatedApp({ role }: { role: UserRole }) {
  // "Conectado" = falando com a central pela rede local (não depende de internet).
  const [isOnline, setIsOnline] = useState<boolean>(socket.connected);

  useEffect(() => {
    const onConnect = () => setIsOnline(true);
    const onDisconnect = () => setIsOnline(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Carrega as configurações (taxa de serviço, tema...) logo após o login
    loadSettings(true);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-main)' }}>
      <Header isOnline={isOnline} />
      <LicenseBanner />
      <main>
        <Suspense fallback={<ScreenFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to={homeFor(role)} replace />} />
          <Route path="/garcom" element={<Guard role={role} path="/garcom"><WaiterScreen /></Guard>} />
          <Route path="/cozinha" element={<Guard role={role} path="/cozinha"><KitchenScreen type="FOOD" /></Guard>} />
          <Route path="/bar" element={<Guard role={role} path="/bar"><KitchenScreen type="BAR" /></Guard>} />
          <Route path="/caixa" element={<Guard role={role} path="/caixa"><CashierScreen /></Guard>} />
          <Route path="/relatorios" element={<Guard role={role} path="/relatorios"><ReportsStockScreen /></Guard>} />
          <Route path="/fiscal" element={<Guard role={role} path="/fiscal"><FiscalScreen /></Guard>} />
          <Route path="/admin" element={<Guard role={role} path="/admin"><AdminScreen /></Guard>} />
          <Route path="*" element={<Navigate to={homeFor(role)} replace />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

export default App;
