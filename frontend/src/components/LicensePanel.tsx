import React, { useState } from 'react';
import { KeyRound, RefreshCw, Smartphone, FileUp, ShieldCheck, AlertTriangle, CheckCircle2, Clock, Lock } from 'lucide-react';
import { api, type LicenseState } from '../services/api';
import { useLicense } from '../services/license';

interface LicensePanelProps {
  onMessage: (type: 'success' | 'error', text: string) => void;
}

const STATE_LABEL: Record<LicenseState, { label: string; badge: string }> = {
  TRIAL: { label: 'Avaliação', badge: 'badge-info' },
  TRIAL_EXPIRED: { label: 'Avaliação terminada', badge: 'badge-occupied' },
  ACTIVE: { label: 'Em dia', badge: 'badge-free' },
  DUE_SOON: { label: 'Vence em breve', badge: 'badge-pending' },
  GRACE: { label: 'Em atraso', badge: 'badge-occupied' },
  BLOCKED: { label: 'Bloqueada', badge: 'badge-occupied' },
  INVALID: { label: 'Inválida', badge: 'badge-occupied' },
  CLOCK: { label: 'Relógio atrasado', badge: 'badge-occupied' }
};

function formatDate(iso?: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
}

/**
 * Gestão → Licença. Ativação deste computador, atualização depois de pagar e
 * renovação quando a central está sem internet (pelo celular ou por arquivo).
 */
export const LicensePanel: React.FC<LicensePanelProps> = ({ onMessage }) => {
  const [status, reload] = useLicense();
  const [busy, setBusy] = useState<string | null>(null);
  const [showActivate, setShowActivate] = useState(false);
  const [form, setForm] = useState({ server_url: '', client_id: '', activation_code: '' });
  const [tokenText, setTokenText] = useState('');

  if (!status) return <div className="empty-state">Carregando...</div>;

  const activated = Boolean(status.clientId && status.serverUrl);
  const st = STATE_LABEL[status.state];

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      onMessage('success', ok);
      await reload();
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível concluir.');
    } finally {
      setBusy(null);
    }
  }

  async function handleActivate(e: React.FormEvent) {
    e.preventDefault();
    await run('activate', () => api.activateLicense(form.server_url.trim(), form.client_id.trim(), form.activation_code.trim()), 'Licença ativada neste computador.');
    setShowActivate(false);
  }

  async function handleViaPhone() {
    if (!status?.serverUrl || !status.clientId || !status.fingerprint) return;
    await run('phone', async () => {
      const token = await api.fetchLicenseFromCloud(status.serverUrl!, status.clientId!, status.fingerprint!);
      await api.installLicense(token);
    }, 'Licença renovada pelo celular.');
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setTokenText((await file.text()).trim());
  }

  return (
    <div style={{ width: '100%', maxWidth: '760px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <h2 className="section-title"><ShieldCheck size={18} /> Licença de uso</h2>
          <span className={`badge ${st.badge}`}>{st.label}</span>
        </div>

        <div className={`alert ${status.blocked || status.state === 'GRACE' ? 'alert-error' : status.state === 'DUE_SOON' ? 'alert-warning' : 'alert-info'}`}>
          {status.blocked ? <Lock size={17} /> : status.state === 'ACTIVE' ? <CheckCircle2 size={17} /> : <Clock size={17} />}
          {status.message}
        </div>
        {!status.enforced && (
          <div className="alert alert-warning"><AlertTriangle size={17} /> Modo de desenvolvimento: a licença é mostrada, mas não bloqueia nada (LICENSE_ENFORCE=0).</div>
        )}

        <div className="form-grid">
          <div><div className="label">Cliente</div><div>{status.clientName ?? '—'}</div></div>
          <div><div className="label">Plano</div><div>{status.plan ?? '—'}{status.features && status.features.length > 0 ? ` (${status.features.join(', ')})` : ''}</div></div>
          <div><div className="label">Pago até</div><div>{formatDate(status.paidUntil)}</div></div>
          <div><div className="label">Bloqueia a partir de</div><div>{status.validUntil ? `${formatDate(status.validUntil)} (fim do dia)` : '—'}</div></div>
          <div><div className="label">Código do cliente</div><div style={{ fontFamily: 'monospace' }}>{status.clientId ?? '—'}</div></div>
          <div><div className="label">Identificação deste computador</div><div style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{status.fingerprint}</div></div>
          <div><div className="label">Última atualização</div><div>{status.lastRefreshAt ?? '—'}</div></div>
        </div>
        {status.lastRefreshError && <p className="hint">Última tentativa de atualizar: {status.lastRefreshError}</p>}

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {activated && (
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => run('refresh', () => api.refreshLicense(), 'Licença atualizada.')}>
              <RefreshCw size={16} /> {busy === 'refresh' ? 'Atualizando...' : 'Atualizar agora'}
            </button>
          )}
          <button className="btn btn-outline" onClick={() => setShowActivate(v => !v)}>
            <KeyRound size={16} /> {activated ? 'Ativar com outro código' : 'Ativar licença'}
          </button>
        </div>
      </section>

      {showActivate && (
        <form onSubmit={handleActivate} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h3 className="section-title">Ativar este computador</h3>
          <p className="hint">Use os dados enviados pelo suporte na contratação. Precisa de internet neste momento.</p>
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="lic-url">Servidor de licenças</label>
              <input id="lic-url" className="input" placeholder="https://licencas.seudominio.com.br" value={form.server_url} onChange={e => setForm({ ...form, server_url: e.target.value })} required />
            </div>
            <div className="field">
              <label className="label" htmlFor="lic-client">Código do cliente</label>
              <input id="lic-client" className="input" autoCapitalize="none" value={form.client_id} onChange={e => setForm({ ...form, client_id: e.target.value })} required />
            </div>
            <div className="field">
              <label className="label" htmlFor="lic-code">Código de ativação</label>
              <input id="lic-code" className="input" autoCapitalize="characters" placeholder="XXXX-XXXX-XXXX" value={form.activation_code} onChange={e => setForm({ ...form, activation_code: e.target.value })} required />
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy !== null}><KeyRound size={16} /> {busy === 'activate' ? 'Ativando...' : 'Ativar'}</button>
        </form>
      )}

      {activated && (
        <section className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h3 className="section-title">Pagou, mas a central está sem internet?</h3>
          <p className="hint">
            Abra esta tela no seu celular com os <strong>dados móveis (4G)</strong> ligados e conectado ao Wi-Fi do
            restaurante: o celular busca a licença na internet e entrega à central.
          </p>
          <button className="btn btn-outline" disabled={busy !== null} onClick={handleViaPhone}>
            <Smartphone size={16} /> {busy === 'phone' ? 'Buscando...' : 'Buscar licença por este aparelho'}
          </button>

          <p className="hint">Ou cole aqui o arquivo de licença enviado pelo suporte (por WhatsApp ou e-mail):</p>
          <input type="file" accept=".txt,.lic,text/plain" onChange={e => handleFile(e.target.files?.[0])} aria-label="Arquivo de licença" />
          <textarea className="input" rows={3} value={tokenText} onChange={e => setTokenText(e.target.value)} placeholder="Conteúdo do arquivo de licença" style={{ fontFamily: 'monospace', fontSize: '0.75rem' }} />
          <button className="btn btn-outline" disabled={busy !== null || tokenText.length < 20}
            onClick={() => run('file', () => api.installLicense(tokenText), 'Licença instalada.').then(() => setTokenText(''))}>
            <FileUp size={16} /> Instalar licença
          </button>
        </section>
      )}
    </div>
  );
};
