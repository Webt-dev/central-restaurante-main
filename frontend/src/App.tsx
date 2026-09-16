import { useState, useEffect, Component, type ErrorInfo, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { WaiterScreen } from './components/WaiterScreen';
import { KitchenScreen } from './components/KitchenScreen';
import { CashierScreen } from './components/CashierScreen';
import { ReportsStockScreen } from './components/ReportsStockScreen';
import { AdminScreen } from './components/AdminScreen';
import { offlineDb } from './services/offlineDb';
import { socket, joinRoom } from './services/socket';
import { api } from './services/api';
import { loadSettings } from './services/settings';

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

export function AppContent() {
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [offlineCount, setOfflineCount] = useState<number>(0);
  const location = useLocation();

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (socket) {
      socket.on('connect', () => setIsOnline(true));
      socket.on('disconnect', () => setIsOnline(false));
    }

    checkOfflineCount();
    // Carrega as configurações (inclusive a taxa de serviço) uma única vez no início
    loadSettings();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const path = location.pathname;
    if (path.includes('/cozinha') || path.includes('/bar')) joinRoom('kitchen');
    if (path.includes('/garcom')) joinRoom('waiter');
    if (path.includes('/caixa')) joinRoom('cashier');
  }, [location.pathname]);

  async function checkOfflineCount() {
    if (!offlineDb) return;
    try {
      const pending = await offlineDb.offlineOrders.where('synced').equals(0).count();
      setOfflineCount(pending);
    } catch {
      setOfflineCount(0);
    }
  }

  async function handleSyncOffline() {
    if (!offlineDb) return;
    try {
      const pendingOrders = await offlineDb.offlineOrders.where('synced').equals(0).toArray();
      if (pendingOrders.length === 0) return;

      for (const pOrder of pendingOrders) {
        try {
          await api.createOrder(pOrder.table_id, pOrder.items, pOrder.offline_sync_id);
          await offlineDb.offlineOrders.update(pOrder.id!, { synced: 1 });
        } catch (err) {
          console.error('Erro ao sincronizar pedido offline:', err);
        }
      }
      checkOfflineCount();
    } catch (err) {
      console.error('Erro na sincronização em lote:', err);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-main)' }}>
      <Header isOnline={isOnline} offlineCount={offlineCount} onSyncOffline={handleSyncOffline} />
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/garcom" replace />} />
          <Route path="/garcom" element={<WaiterScreen isOnline={isOnline} onOrderCreated={checkOfflineCount} />} />
          <Route path="/cozinha" element={<KitchenScreen type="FOOD" />} />
          <Route path="/bar" element={<KitchenScreen type="BAR" />} />
          <Route path="/caixa" element={<CashierScreen />} />
          <Route path="/relatorios" element={<ReportsStockScreen />} />
          <Route path="/admin" element={<AdminScreen />} />
          <Route path="*" element={<Navigate to="/garcom" replace />} />
        </Routes>
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
