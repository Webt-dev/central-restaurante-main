import React, { useEffect, useState } from 'react';
import { Lock, LogIn, ShieldAlert, UserPlus, RefreshCw } from 'lucide-react';
import { api } from '../services/api';

/**
 * Porta de entrada do sistema.
 *
 * - Instalação nova (nenhum usuário): cria o primeiro administrador com
 *   senha própria. Não existe mais senha padrão de fábrica.
 * - Demais casos: login com o usuário de quem vai operar este aparelho.
 */
export const LoginScreen: React.FC = () => {
  const [mode, setMode] = useState<'loading' | 'login' | 'setup' | 'offline'>('loading');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [installCode, setInstallCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    checkSetup();
  }, []);

  async function checkSetup() {
    setMode('loading');
    try {
      const { needsSetup, needsInstallCode } = await api.setupStatus();
      setNeedsCode(!!needsInstallCode);
      setMode(needsSetup ? 'setup' : 'login');
    } catch {
      setMode('offline');
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.login(username.trim(), password);
    } catch (err: any) {
      setError(err.message || 'Usuário ou senha incorretos.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('A senha do administrador deve ter pelo menos 8 caracteres.');
    if (password !== confirm) return setError('A senha e a confirmação não são iguais.');
    setBusy(true);
    try {
      await api.setup(name.trim(), username.trim(), password, installCode.trim() || undefined);
    } catch (err: any) {
      setError(err.message || 'Não foi possível concluir a configuração.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: '430px', paddingTop: '40px' }}>
      <div className="card card-pad animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {mode === 'setup' ? <UserPlus size={20} color="var(--text-secondary)" /> : <Lock size={20} color="var(--text-secondary)" />}
          <div>
            <h1 className="page-title">{mode === 'setup' ? 'Configuração inicial' : 'Entrar'}</h1>
            <div className="page-subtitle">
              {mode === 'setup'
                ? 'Crie o usuário administrador desta instalação.'
                : 'Use o seu usuário para operar este aparelho.'}
            </div>
          </div>
        </div>

        {error && (
          <div className="alert alert-error" role="alert">
            <ShieldAlert size={17} /><span>{error}</span>
          </div>
        )}

        {mode === 'loading' && <p className="hint">Conectando à central...</p>}

        {mode === 'offline' && (
          <>
            <div className="alert alert-error">
              <ShieldAlert size={17} /><span>Não foi possível falar com a central. Verifique se este aparelho está na rede do restaurante.</span>
            </div>
            <button onClick={checkSetup} className="btn btn-primary btn-block"><RefreshCw size={17} /> Tentar de novo</button>
          </>
        )}

        {mode === 'login' && (
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="field">
              <label className="label" htmlFor="login-user">Usuário</label>
              <input id="login-user" type="text" autoComplete="username" autoCapitalize="none" value={username}
                onChange={e => setUsername(e.target.value)} className="input" required autoFocus />
            </div>
            <div className="field">
              <label className="label" htmlFor="login-pass">Senha</label>
              <input id="login-pass" type="password" autoComplete="current-password" value={password}
                onChange={e => setPassword(e.target.value)} className="input" required />
            </div>
            <button type="submit" disabled={busy} className="btn btn-primary btn-block">
              <LogIn size={17} /> {busy ? 'Entrando...' : 'Entrar'}
            </button>
            <p className="hint">Esqueceu a senha? Peça ao administrador para redefinir em Gestão → Usuários.</p>
          </form>
        )}

        {mode === 'setup' && (
          <form onSubmit={handleSetup} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {needsCode && (
              <div className="field">
                <label className="label" htmlFor="setup-code">Código de instalação</label>
                <input id="setup-code" type="text" autoCapitalize="characters" autoComplete="off" value={installCode}
                  onChange={e => setInstallCode(e.target.value)} className="input" placeholder="XXXX-XXXX-XXXX" required autoFocus />
                <p className="hint">Aparece na janela do computador principal logo após a instalação. Protege contra alguém da rede criar o administrador antes de você.</p>
              </div>
            )}
            <div className="field">
              <label className="label" htmlFor="setup-name">Seu nome</label>
              <input id="setup-name" type="text" value={name} onChange={e => setName(e.target.value)} className="input" required autoFocus={!needsCode} />
            </div>
            <div className="field">
              <label className="label" htmlFor="setup-user">Usuário</label>
              <input id="setup-user" type="text" autoComplete="username" autoCapitalize="none" value={username}
                onChange={e => setUsername(e.target.value)} className="input" required minLength={3} />
            </div>
            <div className="field">
              <label className="label" htmlFor="setup-pass">Senha (mínimo 8 caracteres)</label>
              <input id="setup-pass" type="password" autoComplete="new-password" value={password}
                onChange={e => setPassword(e.target.value)} className="input" required minLength={8} />
            </div>
            <div className="field">
              <label className="label" htmlFor="setup-confirm">Confirme a senha</label>
              <input id="setup-confirm" type="password" autoComplete="new-password" value={confirm}
                onChange={e => setConfirm(e.target.value)} className="input" required minLength={8} />
            </div>
            <button type="submit" disabled={busy} className="btn btn-primary btn-block">
              <UserPlus size={17} /> {busy ? 'Criando...' : 'Criar administrador e entrar'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
