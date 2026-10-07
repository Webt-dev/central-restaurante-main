import React, { useEffect, useState } from 'react';
import { Wallet, ArrowDownCircle, ArrowUpCircle, Unlock, X, Save } from 'lucide-react';
import { api, type CashierSession } from '../services/api';
import { socket } from '../services/socket';
import { formatBRL } from '../services/settings';

interface CashDrawerPanelProps {
  onMessage: (type: 'success' | 'error', text: string) => void;
}

type MovementType = 'SANGRIA' | 'SUPRIMENTO';

function parseMoney(value: string): number {
  return Number(value.replace(/\./g, '').replace(',', '.'));
}

/**
 * Gaveta do caixa: abertura com fundo de troco, sangria (retirada),
 * suprimento (reforço) e o dinheiro que deve haver na gaveta agora.
 * Esse valor esperado é o que será comparado com a contagem no fechamento.
 */
export const CashDrawerPanel: React.FC<CashDrawerPanelProps> = ({ onMessage }) => {
  const [session, setSession] = useState<CashierSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [initial, setInitial] = useState('');
  const [movement, setMovement] = useState<MovementType | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
    socket.on('payment:processed', load);
    return () => {
      socket.off('payment:processed', load);
    };
  }, []);

  async function load() {
    try {
      setSession(await api.getCashierSession());
    } catch {
      // painel é informativo; o caixa segue funcionando
    } finally {
      setLoaded(true);
    }
  }

  async function handleOpen(e: React.FormEvent) {
    e.preventDefault();
    const value = initial.trim() ? parseMoney(initial) : 0;
    if (!Number.isFinite(value) || value < 0) return onMessage('error', 'Informe um fundo de troco válido.');
    setBusy(true);
    try {
      await api.openCashier(value);
      setInitial('');
      onMessage('success', `Caixa aberto com fundo de troco de ${formatBRL(value)}.`);
      await load();
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível abrir o caixa.');
    } finally {
      setBusy(false);
    }
  }

  async function handleMovement(e: React.FormEvent) {
    e.preventDefault();
    if (!movement) return;
    const value = parseMoney(amount);
    if (!Number.isFinite(value) || value <= 0) return onMessage('error', 'Informe um valor maior que zero.');
    if (reason.trim().length < 3) return onMessage('error', 'Informe o motivo.');
    setBusy(true);
    try {
      await api.addCashMovement(movement, value, reason.trim());
      onMessage('success', `${movement === 'SANGRIA' ? 'Sangria' : 'Suprimento'} de ${formatBRL(value)} registrada.`);
      setMovement(null);
      setAmount('');
      setReason('');
      await load();
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível registrar.');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  if (!session) {
    return (
      <form onSubmit={handleOpen} className="card card-pad" style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          <h2 className="section-title"><Wallet size={18} /> Caixa fechado</h2>
          <p className="hint">Abra o caixa informando o dinheiro que já está na gaveta (fundo de troco).</p>
        </div>
        <div className="field" style={{ width: '170px' }}>
          <label className="label" htmlFor="cash-initial">Fundo de troco (R$)</label>
          <input id="cash-initial" className="input" inputMode="decimal" placeholder="0,00" value={initial} onChange={e => setInitial(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}><Unlock size={16} /> Abrir caixa</button>
      </form>
    );
  }

  const openedAt = new Date(session.opened_at.replace(' ', 'T')).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <h2 className="section-title"><Wallet size={18} /> Dinheiro esperado na gaveta: <span className="money">{formatBRL(session.cash.expected_cash)}</span></h2>
          <p className="hint">
            Aberto às {openedAt}{session.opened_by_name ? ` por ${session.opened_by_name}` : ''} · Fundo {formatBRL(session.cash.initial_balance)}
            {' '}+ vendas em dinheiro {formatBRL(session.cash.cash_sales)}
            {session.cash.suprimentos > 0 && ` + suprimentos ${formatBRL(session.cash.suprimentos)}`}
            {session.cash.sangrias > 0 && ` − sangrias ${formatBRL(session.cash.sangrias)}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" onClick={() => setMovement('SANGRIA')}><ArrowUpCircle size={15} /> Sangria</button>
          <button className="btn btn-outline btn-sm" onClick={() => setMovement('SUPRIMENTO')}><ArrowDownCircle size={15} /> Suprimento</button>
        </div>
      </div>

      {movement && (
        <form onSubmit={handleMovement} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ width: '150px' }}>
            <label className="label" htmlFor="mov-amount">{movement === 'SANGRIA' ? 'Valor retirado' : 'Valor colocado'} (R$)</label>
            <input id="mov-amount" className="input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required autoFocus />
          </div>
          <div className="field" style={{ flex: '1 1 200px' }}>
            <label className="label" htmlFor="mov-reason">Motivo</label>
            <input id="mov-reason" className="input" value={reason} onChange={e => setReason(e.target.value)} maxLength={200}
              placeholder={movement === 'SANGRIA' ? 'Ex.: depósito no cofre' : 'Ex.: reforço de troco'} required />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}><Save size={15} /> Registrar</button>
          <button type="button" className="btn btn-ghost" onClick={() => setMovement(null)} aria-label="Cancelar"><X size={16} /></button>
        </form>
      )}
    </div>
  );
};
