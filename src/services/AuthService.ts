import { randomUUID } from 'node:crypto';
import { UserRepository } from '../repositories/UserRepository.js';
import { verifyPassword, generateToken, hashPassword } from '../utils/crypto.js';
import { PublicUser, User, UserRole } from '../models/types.js';
import { HttpError } from '../utils/httpError.js';
import { lockedForSeconds, registerFailure, registerSuccess } from './loginThrottle.js';
import { audit } from './AuditService.js';
import { db } from '../config/database.js';

/** Hash de uma senha qualquer: usado quando o usuário não existe, para o tempo de resposta não revelar isso. */
const DUMMY_HASH_PROMISE = hashPassword('usuario-inexistente');

/**
 * Senhas de fábrica das versões antigas (publicadas no README e no manual).
 * Instalações atualizadas ainda podem tê-las: quem entra com uma delas é
 * obrigado a trocar antes de usar o sistema.
 */
const LEGACY_DEFAULT_PASSWORDS = new Set(['123456', 'admin123', 'caixa123', 'garcom123', 'cozinha123']);

export const MIN_PASSWORD_LENGTH: Record<UserRole, number> = {
  ADMIN: 8,
  CASHIER: 6,
  WAITER: 6,
  KITCHEN: 6
};

export function assertPasswordPolicy(password: string, role: UserRole): void {
  const min = MIN_PASSWORD_LENGTH[role];
  if (!password || password.length < min) {
    throw new HttpError(400, `A senha deve ter pelo menos ${min} caracteres.`);
  }
}

function toPublic(user: User): PublicUser {
  const { password_hash, token_version, pin_hash, ...rest } = user;
  return rest;
}

function issueToken(user: User, mustChangePassword = false): string {
  return generateToken({
    userId: user.id,
    name: user.name,
    role: user.role,
    tv: user.token_version,
    ...(mustChangePassword ? { mcp: true } : {})
  });
}

export class AuthService {
  static async login(username: string, password: string, ip: string): Promise<{ user: PublicUser; token: string; mustChangePassword: boolean }> {
    const wait = lockedForSeconds(ip, username);
    if (wait > 0) {
      throw new HttpError(429, `Muitas tentativas. Tente novamente em ${wait} segundos.`);
    }

    const user = UserRepository.findByUsername(username);
    const valid = user
      ? await verifyPassword(password, user.password_hash)
      : (await verifyPassword(password, await DUMMY_HASH_PROMISE), false);

    if (!user || !valid || !user.active) {
      registerFailure(ip, username);
      audit({ action: 'auth.login_failed', entity: 'user', entityId: user?.id ?? null, ip, after: { username } });
      throw new HttpError(401, 'Usuário ou senha inválidos.');
    }

    registerSuccess(ip, username);
    audit({ action: 'auth.login', entity: 'user', entityId: user.id, userId: user.id, userName: user.name, role: user.role, ip });
    const mustChangePassword = LEGACY_DEFAULT_PASSWORDS.has(password) || password.length < MIN_PASSWORD_LENGTH[user.role];
    return { user: toPublic(user), token: issueToken(user, mustChangePassword), mustChangePassword };
  }

  static needsSetup(): boolean {
    return UserRepository.count() === 0;
  }

  /**
   * Cria o primeiro administrador. Só funciona enquanto não existe nenhum
   * usuário; depois disso a rota responde 409 para sempre.
   */
  static async setup(name: string, username: string, password: string, ip: string): Promise<{ user: PublicUser; token: string }> {
    assertPasswordPolicy(password, 'ADMIN');
    const passwordHash = await hashPassword(password);

    const user = db.transaction(() => {
      if (!this.needsSetup()) {
        throw new HttpError(409, 'O sistema já foi configurado.');
      }
      return UserRepository.create({ id: randomUUID(), name, username, role: 'ADMIN', password_hash: passwordHash });
    })();

    audit({ action: 'auth.setup', entity: 'user', entityId: user.id, userId: user.id, userName: user.name, role: user.role, ip });
    return { user: toPublic(user), token: issueToken(user) };
  }

  static async createUser(name: string, username: string, role: UserRole, password: string): Promise<PublicUser> {
    if (UserRepository.findByUsername(username)) {
      throw new HttpError(409, `Nome de usuário '${username}' já está em uso.`);
    }
    assertPasswordPolicy(password, role);

    const user = UserRepository.create({
      id: randomUUID(),
      name,
      username,
      role,
      password_hash: await hashPassword(password)
    });
    return toPublic(user);
  }

  static listUsers(): PublicUser[] {
    return UserRepository.listAll();
  }

  static updateUser(actorId: string, id: string, data: { name: string; role: UserRole; active: boolean }): { before: PublicUser; after: PublicUser } {
    const existing = UserRepository.findById(id);
    if (!existing) throw new HttpError(404, 'Usuário não encontrado.');

    const losesAdmin = existing.role === 'ADMIN' && existing.active && (data.role !== 'ADMIN' || !data.active);
    if (losesAdmin && UserRepository.countActiveAdmins() <= 1) {
      throw new HttpError(400, 'É preciso manter pelo menos um administrador ativo.');
    }
    if (id === actorId && !data.active) {
      throw new HttpError(400, 'Você não pode desativar o próprio usuário.');
    }

    UserRepository.updateProfile(id, data);
    return { before: toPublic(existing), after: toPublic(UserRepository.findById(id)!) };
  }

  static async resetPassword(id: string, newPassword: string): Promise<PublicUser> {
    const user = UserRepository.findById(id);
    if (!user) throw new HttpError(404, 'Usuário não encontrado.');
    assertPasswordPolicy(newPassword, user.role);
    UserRepository.updatePassword(id, await hashPassword(newPassword));
    return toPublic(user);
  }

  /**
   * PIN numérico (4 a 6 dígitos) do supervisor. Autoriza no salão ações que o
   * caixa ou o garçom não podem fazer sozinhos, como cancelar item em preparo.
   */
  static async setOwnPin(userId: string, currentPassword: string, pin: string | null): Promise<void> {
    const user = UserRepository.findById(userId);
    if (!user || user.role !== 'ADMIN') throw new HttpError(403, 'Só administradores têm PIN de supervisor.');
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new HttpError(400, 'A senha atual está incorreta.');
    }
    if (pin !== null && !/^\d{4,6}$/.test(pin)) {
      throw new HttpError(400, 'O PIN deve ter de 4 a 6 números.');
    }
    UserRepository.setPin(userId, pin === null ? null : await hashPassword(pin));
  }

  /** Confere o PIN contra os administradores ativos. Limitado como o login. */
  static async verifySupervisorPin(pin: string, ip: string): Promise<PublicUser> {
    const key = 'pin-supervisor';
    const wait = lockedForSeconds(ip, key);
    if (wait > 0) {
      throw new HttpError(429, `Muitas tentativas de PIN. Tente novamente em ${wait} segundos.`, 'SUPERVISOR_REQUIRED');
    }
    for (const admin of UserRepository.listActiveAdminsWithPin()) {
      if (await verifyPassword(pin, admin.pin_hash!)) {
        registerSuccess(ip, key);
        return toPublic(admin);
      }
    }
    registerFailure(ip, key);
    throw new HttpError(403, 'PIN de supervisor inválido.', 'SUPERVISOR_REQUIRED');
  }

  /** Troca de usuário/senha pelo próprio dono da conta, exigindo a senha atual. */
  static async changeOwnCredentials(userId: string, data: { currentPassword: string; newUsername?: string; newPassword: string }): Promise<{ user: PublicUser; token: string }> {
    const user = UserRepository.findById(userId);
    if (!user) throw new HttpError(404, 'Usuário não encontrado.');

    if (!(await verifyPassword(data.currentPassword, user.password_hash))) {
      throw new HttpError(400, 'A senha atual está incorreta.');
    }
    assertPasswordPolicy(data.newPassword, user.role);

    const newUsername = data.newUsername?.trim();
    if (newUsername && newUsername !== user.username) {
      if (newUsername.length < 3) throw new HttpError(400, 'O nome de usuário deve ter no mínimo 3 caracteres.');
      const taken = UserRepository.findByUsername(newUsername);
      if (taken && taken.id !== userId) throw new HttpError(409, `O nome de usuário "${newUsername}" já está em uso.`);
      UserRepository.updateUsername(userId, newUsername);
    }

    UserRepository.updatePassword(userId, await hashPassword(data.newPassword));
    // A troca de senha invalida o token atual: devolvemos um novo para a sessão continuar.
    const updated = UserRepository.findById(userId)!;
    return { user: toPublic(updated), token: issueToken(updated) };
  }
}
