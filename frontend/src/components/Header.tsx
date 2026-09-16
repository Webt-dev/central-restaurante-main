import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Utensils, ChefHat, GlassWater, Receipt, BarChart3, Settings,
  Wifi, WifiOff, RefreshCw
} from 'lucide-react';

interface HeaderProps {
  isOnline: boolean;
  offlineCount: number;
  onSyncOffline: () => void;
}

/**
 * Navegação do sistema.
 *
 * A aba "Notas fiscais" foi removida: a rota /fiscal só existe se o módulo
 * fiscal tiver sido instalado (FiscalScreen + rotas do backend). Enquanto
 * isso não acontece, o botão levava a uma tela inexistente.
 * Para reativar, basta acrescentar de volta:
 *   { path: '/fiscal', label: 'Notas fiscais', short: 'Notas', Icon: FileText }
 */
const NAV_ITEMS = [
  { path: '/garcom', label: 'Garçom', short: 'Garçom', Icon: Utensils },
  { path: '/cozinha', label: 'Cozinha', short: 'Cozinha', Icon: ChefHat },
  { path: '/bar', label: 'Bar', short: 'Bar', Icon: GlassWater },
  { path: '/caixa', label: 'Caixa', short: 'Caixa', Icon: Receipt },
  { path: '/relatorios', label: 'Relatórios', short: 'Relatos', Icon: BarChart3 },
  { path: '/admin', label: 'Gestão', short: 'Gestão', Icon: Settings }
];

export const Header: React.FC<HeaderProps> = ({ isOnline, offlineCount, onSyncOffline }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname;

  function isActive(path: string) {
    if (path === '/garcom') return currentPath.includes('/garcom') || currentPath === '/';
    return currentPath.includes(path);
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand" onClick={() => navigate('/garcom')}>
            <img
              src="/icon.png"
              alt=""
              onError={(e) => {
                (e.target as HTMLImageElement).src = '/favicon.ico';
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div className="brand-name">Central de Restaurante</div>
              <div className="brand-sub">Pedidos, cozinha e caixa em um só lugar</div>
            </div>
          </div>

          <div className="toolbar">
            {offlineCount > 0 && (
              <button
                onClick={onSyncOffline}
                className="btn btn-outline btn-sm"
                title="Enviar os pedidos que foram salvos sem internet"
              >
                <RefreshCw size={14} className="spin" />
                <span className="hide-mobile">Enviar </span>{offlineCount}
                <span className="hide-mobile"> pendente{offlineCount === 1 ? '' : 's'}</span>
              </button>
            )}

            <span className={`conn-pill ${isOnline ? 'conn-online' : 'conn-offline'}`}>
              {isOnline ? <Wifi size={13} /> : <WifiOff size={13} />}
              <span className="hide-mobile">{isOnline ? 'Conectado' : 'Sem conexão'}</span>
            </span>
          </div>

          <nav className="nav-tabs">
            {NAV_ITEMS.map(({ path, label, Icon }) => (
              <button
                key={path}
                onClick={() => navigate(path)}
                className={`nav-tab ${isActive(path) ? 'is-active' : ''}`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <nav className="mobile-nav">
        {NAV_ITEMS.map(({ path, short, Icon }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            className={`mobile-nav-item ${isActive(path) ? 'is-active' : ''}`}
          >
            <Icon size={19} />
            {short}
          </button>
        ))}
      </nav>
    </>
  );
};
