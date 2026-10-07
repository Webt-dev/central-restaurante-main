import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, X } from 'lucide-react';

interface SupervisorPinModalProps {
  title: string;
  description: string;
  onConfirm: (pin: string, reason: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Autorização do supervisor para ações sensíveis no salão (ex.: cancelar
 * item que a cozinha já preparou). O supervisor digita o PIN no aparelho e o
 * motivo fica registrado na auditoria com o nome de quem autorizou.
 */
export const SupervisorPinModal: React.FC<SupervisorPinModalProps> = ({ title, description, onConfirm, onCancel }) => {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (reason.trim().length < 3) return setError('Informe o motivo.');
    if (!/^\d{4,6}$/.test(pin)) return setError('O PIN tem de 4 a 6 números.');
    setBusy(true);
    try {
      await onConfirm(pin, reason.trim());
    } catch (err: any) {
      setError(err.message || 'Não foi possível autorizar.');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pin-title">
      <form onSubmit={handleSubmit} className="modal card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div className="modal-head">
          <h2 id="pin-title" className="section-title"><ShieldCheck size={18} /> {title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} aria-label="Fechar"><X size={18} /></button>
        </div>
        <p className="hint">{description}</p>

        {error && <div className="alert alert-error" role="alert"><ShieldAlert size={16} /> {error}</div>}

        <div className="field">
          <label className="label" htmlFor="pin-reason">Motivo</label>
          <input id="pin-reason" className="input" value={reason} onChange={e => setReason(e.target.value)} maxLength={200} required autoFocus />
        </div>
        <div className="field">
          <label className="label" htmlFor="pin-code">PIN do supervisor</label>
          <input id="pin-code" className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={6}
            value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} required />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={busy}><ShieldCheck size={16} /> {busy ? 'Conferindo...' : 'Autorizar'}</button>
        </div>
      </form>
    </div>
  );
};
