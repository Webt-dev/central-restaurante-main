import React, { useEffect, useState } from 'react';
import { Plus, Save, X, KeyRound, Pencil, UserCheck, UserX } from 'lucide-react';
import type { ManagedUser } from '../types';
import { api } from '../services/api';
import { useSession, ROLE_LABELS, type UserRole } from '../services/session';

interface UsersPanelProps {
  onMessage: (type: 'success' | 'error', text: string) => void;
}

const ROLES: UserRole[] = ['WAITER', 'KITCHEN', 'CASHIER', 'ADMIN'];
const MIN_PASSWORD: Record<UserRole, number> = { ADMIN: 8, CASHIER: 6, WAITER: 6, KITCHEN: 6 };

const EMPTY_FORM = { name: '', username: '', role: 'WAITER' as UserRole, password: '' };

/**
 * Gestão de usuários (somente ADMIN). Cada pessoa tem o próprio login, o que
 * permite saber quem lançou, cancelou ou recebeu cada pedido.
 */
export const UsersPanel: React.FC<UsersPanelProps> = ({ onMessage }) => {
  const session = useSession();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [resetting, setResetting] = useState<ManagedUser | null>(null);
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      setUsers(await api.listUsers());
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível carregar os usuários.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (form.password.length < MIN_PASSWORD[form.role]) {
      return onMessage('error', `A senha deve ter pelo menos ${MIN_PASSWORD[form.role]} caracteres.`);
    }
    try {
      await api.createUser({ ...form, name: form.name.trim(), username: form.username.trim() });
      onMessage('success', `Usuário ${form.username} criado.`);
      setForm(EMPTY_FORM);
      setShowCreate(false);
      load();
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível criar o usuário.');
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      await api.updateUser(editing.id, { name: editing.name.trim(), role: editing.role, active: Boolean(editing.active) });
      onMessage('success', 'Usuário atualizado. As sessões abertas dele foram encerradas.');
      setEditing(null);
      load();
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível atualizar o usuário.');
    }
  }

  async function toggleActive(user: ManagedUser) {
    try {
      await api.updateUser(user.id, { name: user.name, role: user.role, active: !user.active });
      onMessage('success', user.active ? `${user.name} foi desativado.` : `${user.name} foi reativado.`);
      load();
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível alterar o usuário.');
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resetting) return;
    if (newPassword.length < MIN_PASSWORD[resetting.role]) {
      return onMessage('error', `A senha deve ter pelo menos ${MIN_PASSWORD[resetting.role]} caracteres.`);
    }
    try {
      await api.resetUserPassword(resetting.id, newPassword);
      onMessage('success', `Senha de ${resetting.name} redefinida.`);
      setResetting(null);
      setNewPassword('');
    } catch (err: any) {
      onMessage('error', err.message || 'Não foi possível redefinir a senha.');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="card card-pad" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h2 className="section-title">Equipe</h2>
          <p className="hint">Cada pessoa entra com o próprio usuário. Desative quem sair da equipe em vez de apagar.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(v => !v)}>
          {showCreate ? <X size={16} /> : <Plus size={16} />} {showCreate ? 'Cancelar' : 'Novo usuário'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="u-name">Nome</label>
              <input id="u-name" className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label className="label" htmlFor="u-user">Usuário (login)</label>
              <input id="u-user" className="input" autoCapitalize="none" value={form.username}
                onChange={e => setForm({ ...form, username: e.target.value })} required minLength={3} />
            </div>
            <div className="field">
              <label className="label" htmlFor="u-role">Função</label>
              <select id="u-role" className="input" value={form.role} onChange={e => setForm({ ...form, role: e.target.value as UserRole })}>
                {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="u-pass">Senha (mín. {MIN_PASSWORD[form.role]} caracteres)</label>
              <input id="u-pass" type="password" className="input" autoComplete="new-password" value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })} required />
            </div>
          </div>
          <button type="submit" className="btn btn-primary btn-block"><Save size={16} /> Criar usuário</button>
        </form>
      )}

      <div className="card">
        {loading ? (
          <p className="hint card-pad">Carregando...</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Usuário</th>
                  <th>Função</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const isSelf = u.id === session?.user.id;
                  return (
                    <tr key={u.id} style={{ opacity: u.active ? 1 : 0.7 }}>
                      <td>{u.name}{isSelf && <span className="hint"> (você)</span>}</td>
                      <td>{u.username}</td>
                      <td>{ROLE_LABELS[u.role]}</td>
                      <td>
                        <span className={`badge ${u.active ? 'badge-free' : 'badge-pending'}`}>{u.active ? 'Ativo' : 'Desativado'}</span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <button className="btn btn-outline btn-sm" onClick={() => setEditing({ ...u })} aria-label={`Editar ${u.name}`}>
                            <Pencil size={14} /> Editar
                          </button>
                          <button className="btn btn-outline btn-sm" onClick={() => { setResetting(u); setNewPassword(''); }} aria-label={`Redefinir senha de ${u.name}`}>
                            <KeyRound size={14} /> Senha
                          </button>
                          {!isSelf && (
                            <button className="btn btn-outline btn-sm" onClick={() => toggleActive(u)}>
                              {u.active ? <UserX size={14} /> : <UserCheck size={14} />} {u.active ? 'Desativar' : 'Reativar'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="edit-user-title">
          <form onSubmit={handleSaveEdit} className="modal card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <h2 id="edit-user-title" className="section-title">Editar {editing.username}</h2>
            <div className="field">
              <label className="label" htmlFor="e-name">Nome</label>
              <input id="e-name" className="input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} required />
            </div>
            <div className="field">
              <label className="label" htmlFor="e-role">Função</label>
              <select id="e-role" className="input" value={editing.role} onChange={e => setEditing({ ...editing, role: e.target.value as UserRole })}>
                {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline" onClick={() => setEditing(null)}>Cancelar</button>
              <button type="submit" className="btn btn-primary"><Save size={16} /> Salvar</button>
            </div>
          </form>
        </div>
      )}

      {resetting && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="reset-title">
          <form onSubmit={handleResetPassword} className="modal card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <h2 id="reset-title" className="section-title">Nova senha para {resetting.name}</h2>
            <div className="field">
              <label className="label" htmlFor="r-pass">Senha (mín. {MIN_PASSWORD[resetting.role]} caracteres)</label>
              <input id="r-pass" type="password" className="input" autoComplete="new-password" value={newPassword}
                onChange={e => setNewPassword(e.target.value)} required autoFocus />
            </div>
            <p className="hint">As sessões abertas desse usuário serão encerradas.</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline" onClick={() => setResetting(null)}>Cancelar</button>
              <button type="submit" className="btn btn-primary"><KeyRound size={16} /> Redefinir</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
