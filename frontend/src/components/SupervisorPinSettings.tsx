import React, { useState } from 'react';
import { ShieldCheck, Save } from 'lucide-react';
import { api } from '../services/api';

interface SupervisorPinSettingsProps {
  onMessage: (type: 'success' | 'error', text: string) => void;
}

/** Cadastro do PIN de supervisor do administrador logado. */
export const SupervisorPinSettings: React.FC<SupervisorPinSettingsProps> = ({ onMessage }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(pin)) return onMessage('error', 'O PIN deve ter de 4 a 6 números.');
    if (pin !== confirm) return onMessage('error', 'O PIN e a confirmação não são iguais.');
    setBusy(true);
    try {
      await api.setOwnPin(currentPassword, pin);
      onMessage('success', 'PIN de supervisor salvo.');
      setCurrentPassword('');
      setPin('');
      setConfirm('');
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível salvar o PIN.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <h2 className="section-title"><ShieldCheck size={18} color="var(--text-secondary)" /> PIN de supervisor</h2>
        <p className="hint" style={{ marginTop: '4px' }}>
          Usado no caixa para autorizar o cancelamento de itens que a cozinha já preparou. Cada autorização fica registrada com o seu nome.
        </p>
      </div>
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="pin-pass">Sua senha atual</label>
          <input id="pin-pass" type="password" autoComplete="current-password" className="input" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
        </div>
        <div className="field">
          <label className="label" htmlFor="pin-new">Novo PIN (4 a 6 números)</label>
          <input id="pin-new" type="password" inputMode="numeric" autoComplete="off" maxLength={6} className="input" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} required />
        </div>
        <div className="field">
          <label className="label" htmlFor="pin-confirm">Repita o PIN</label>
          <input id="pin-confirm" type="password" inputMode="numeric" autoComplete="off" maxLength={6} className="input" value={confirm} onChange={e => setConfirm(e.target.value.replace(/\D/g, ''))} required />
        </div>
      </div>
      <button type="submit" className="btn btn-outline btn-block" disabled={busy}><Save size={16} /> Salvar PIN</button>
    </form>
  );
};
