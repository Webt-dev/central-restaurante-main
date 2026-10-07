import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Clock, Lock } from 'lucide-react';
import { useLicense } from '../services/license';
import { useSession } from '../services/session';

/**
 * Faixa de aviso da licença logo abaixo do menu.
 *  - Bloqueio (atraso de 8+ dias, avaliação terminada, licença inválida,
 *    relógio atrasado): aparece para TODOS, inclusive garçom e cozinha.
 *  - Vence em breve, atraso dentro da carência e avaliação: só ADMIN e Caixa.
 */
export const LicenseBanner: React.FC = () => {
  const [status] = useLicense();
  const session = useSession();
  const navigate = useNavigate();
  if (!status) return null;

  const role = session?.user.role;
  const isAdmin = role === 'ADMIN';
  const seesNotices = isAdmin || role === 'CASHIER';

  let tone: 'alert-error' | 'alert-warning' | 'alert-info';
  let Icon = AlertTriangle;

  if (status.blocked) {
    tone = 'alert-error';
    Icon = Lock;
  } else if (status.state === 'GRACE') {
    if (!seesNotices) return null;
    tone = 'alert-error';
  } else if (status.state === 'DUE_SOON' || status.state === 'TRIAL') {
    if (!seesNotices) return null;
    tone = status.state === 'TRIAL' ? 'alert-info' : 'alert-warning';
    Icon = Clock;
  } else {
    return null;
  }

  return (
    <div className="license-banner">
      <div className={`alert ${tone}`} role="status">
        <Icon size={17} />
        <span style={{ flex: 1 }}>
          {status.message}
          {!isAdmin && status.blocked && ' Avise o responsável pelo estabelecimento.'}
        </span>
        {isAdmin && (
          <button className="btn btn-sm btn-outline" onClick={() => navigate('/admin?aba=licenca')}>
            {status.blocked || status.state === 'GRACE' ? 'Regularizar' : 'Ver licença'}
          </button>
        )}
      </div>
    </div>
  );
};
