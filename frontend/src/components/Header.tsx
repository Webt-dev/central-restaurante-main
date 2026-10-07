import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Utensils, ChefHat, GlassWater, Receipt, BarChart3, Settings,
  Wifi, WifiOff, RefreshCw, LogOut, AlertTriangle, FileText
} from 'lucide-react';
import { useOutbox } from '../services/outbox';
import { PendingOrdersModal } from './PendingOrdersModal';
import { useSession, canAccess, homeFor, ROLE_LABELS } from '../services/session';
import { useSettings } from '../services/settings';
import { api } from '../services/api';

interface HeaderProps {
  isOnline: boolean;
}

/**
 * Navegação do sistema. Cada papel vê só as suas telas; "Notas fiscais" só
 * aparece quando a emissão de NFC-e está ligada em Gestão → Módulos.
 */
const NAV_ITEMS = [
  { path: '/garcom', label: 'Garçom', short: 'Garçom', Icon: Utensils },
  { path: '/cozinha', label: 'Cozinha', short: 'Cozinha', Icon: ChefHat },
  { path: '/bar', label: 'Bar', short: 'Bar', Icon: GlassWater },
  { path: '/caixa', label: 'Caixa', short: 'Caixa', Icon: Receipt },
  { path: '/relatorios', label: 'Relatórios', short: 'Relatos', Icon: BarChart3 },
  { path: '/fiscal', label: 'Notas fiscais', short: 'Notas', Icon: FileText },
  { path: '/admin', label: 'Gestão', short: 'Gestão', Icon: Settings }
];

export const Header: React.FC<HeaderProps> = ({ isOnline }) => {
  const outbox = useOutbox();
  const [showPending, setShowPending] = useState(false);
  const pendingCount = outbox.filter(o => o.status === 'pending').length;
  const errorCount = outbox.filter(o => o.status === 'error').length;
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname;
  const session = useSession();
  const settings = useSettings();
  const role = session?.user.role ?? 'WAITER';
  // Cada papel só vê as telas que pode abrir.
  const navItems = NAV_ITEMS.filter(item => canAccess(role, item.path) && (item.path !== '/fiscal' || settings.fiscal_enabled));

  function isActive(path: string) {
    if (currentPath === '/') return path === homeFor(role);
    return currentPath.includes(path);
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand" onClick={() => navigate(homeFor(role))}>
            <img
              src="/icon.png"
              alt=""
              onError={(e) => {
                (e.target as HTMLImageElement).src = '/favicon.ico';
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div className="brand-name">{settings.restaurant_name || 'Central de Restaurante'}</div>
              <div className="brand-sub">Pedidos, cozinha e caixa em um só lugar</div>
            </div>
          </div>

          <div className="toolbar">
            {outbox.length > 0 && (
              <button
                onClick={() => setShowPending(true)}
                className={`btn btn-sm ${errorCount > 0 ? 'btn-danger-soft' : 'btn-warning-soft'}`}
                title="Pedidos guardados neste aparelho que ainda não chegaram à central"
              >
                {errorCount > 0 ? <AlertTriangle size={14} /> : <RefreshCw size={14} className="spin" />}
                {outbox.length}
                <span className="hide-mobile">
                  {errorCount > 0 ? ` recusado${errorCount === 1 ? '' : 's'}` : ` pendente${pendingCount === 1 ? '' : 's'}`}
                </span>
              </button>
            )}

            <span className={`conn-pill ${isOnline ? 'conn-online' : 'conn-offline'}`}>
              {isOnline ? <Wifi size={13} /> : <WifiOff size={13} />}
              <span className="hide-mobile">{isOnline ? 'Conectado' : 'Sem conexão'}</span>
            </span>

            {session && (
              <button
                onClick={() => api.logout()}
                className="btn btn-outline btn-sm"
                title={`${session.user.name} (${ROLE_LABELS[role]}) — sair deste aparelho`}
              >
                <LogOut size={14} />
                <span className="hide-mobile">{session.user.name.split(' ')[0]} · Sair</span>
              </button>
            )}
          </div>

          <nav className="nav-tabs">
            {navItems.map(({ path, label, Icon }) => (
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

      {showPending && <PendingOrdersModal onClose={() => setShowPending(false)} />}

      <nav className="mobile-nav">
        {navItems.map(({ path, short, Icon }) => (
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
