import React, { useState } from 'react';
import { KeyRound, ShieldAlert, LogOut } from 'lucide-react';
import { api } from '../services/api';
import { useSession } from '../services/session';

/** Troca obrigatória quando o usuário entrou com senha de fábrica ou fraca. */
export const ChangePasswordScreen: React.FC = () => {
  const session = useSession();
  const min = session?.user.role === 'ADMIN' ? 8 : 6;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < min) return setError(`A nova senha deve ter pelo menos ${min} caracteres.`);
    if (next !== confirm) return setError('A nova senha e a confirmação não são iguais.');
    if (next === current) return setError('A nova senha deve ser diferente da atual.');
    setBusy(true);
    try {
      await api.changeOwnCredentials({ currentPassword: current, newPassword: next });
    } catch (err: any) {
      setError(err.message || 'Não foi possível trocar a senha.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: '430px', paddingTop: '40px' }}>
      <form onSubmit={handleSubmit} className="card card-pad animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <KeyRound size={20} color="var(--text-secondary)" />
          <div>
            <h1 className="page-title">Troque sua senha</h1>
            <div className="page-subtitle">Olá, {session?.user.name}. Sua senha atual é de fábrica ou muito curta.</div>
          </div>
        </div>

        {error && (
          <div className="alert alert-error" role="alert"><ShieldAlert size={17} /><span>{error}</span></div>
        )}

        <div className="field">
          <label className="label" htmlFor="cp-current">Senha atual</label>
          <input id="cp-current" type="password" autoComplete="current-password" className="input" value={current} onChange={e => setCurrent(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label className="label" htmlFor="cp-new">Nova senha (mínimo {min} caracteres)</label>
          <input id="cp-new" type="password" autoComplete="new-password" className="input" value={next} onChange={e => setNext(e.target.value)} required />
        </div>
        <div className="field">
          <label className="label" htmlFor="cp-confirm">Repita a nova senha</label>
          <input id="cp-confirm" type="password" autoComplete="new-password" className="input" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        </div>

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          <KeyRound size={16} /> {busy ? 'Salvando...' : 'Salvar nova senha'}
        </button>
        <button type="button" className="btn btn-outline btn-block" onClick={() => api.logout()}>
          <LogOut size={16} /> Sair
        </button>
      </form>
    </div>
  );
};
