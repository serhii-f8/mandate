import { eq, lte } from 'drizzle-orm';
import type { Db } from './client.js';
import { webLogin, webSession } from './schema.js';

export interface LoginRow {
  stateHash: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  fresh: boolean;
  expiresAt: Date;
}

export interface SessionRow {
  idHash: string;
  subject: string;
  username?: string;
  clientId: string;
  groups: string[];
  authTime: Date;
  csrfToken: string;
  expiresAt: Date;
}

/**
 * Login state and page sessions in PostgreSQL so any `api` instance can serve any page
 * request (NFR-3). Keys are SHA-256 hashes; raw state and cookie values are never stored.
 */
export class PostgresSessionStore {
  constructor(private readonly db: Db) {}

  async createLogin(row: LoginRow): Promise<void> {
    await this.db.insert(webLogin).values(row);
  }

  /** Atomic single-use: the row is deleted by the same statement that reads it (AUTH-5). */
  async consumeLogin(stateHash: string, now: Date): Promise<LoginRow | undefined> {
    const [row] = await this.db.delete(webLogin).where(eq(webLogin.stateHash, stateHash)).returning();
    if (row === undefined || row.expiresAt.getTime() <= now.getTime()) return undefined;
    return row;
  }

  async createSession(row: SessionRow): Promise<void> {
    await this.db.insert(webSession).values({ ...row, username: row.username ?? null });
  }

  async findSession(idHash: string, now: Date): Promise<SessionRow | undefined> {
    const [row] = await this.db.select().from(webSession).where(eq(webSession.idHash, idHash));
    if (row === undefined || row.expiresAt.getTime() <= now.getTime()) return undefined;
    const found: SessionRow = {
      idHash: row.idHash,
      subject: row.subject,
      clientId: row.clientId,
      groups: row.groups,
      authTime: row.authTime,
      csrfToken: row.csrfToken,
      expiresAt: row.expiresAt,
    };
    if (row.username !== null) found.username = row.username;
    return found;
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.db.delete(webSession).where(eq(webSession.idHash, idHash));
  }

  /** Removes expired logins and sessions; returns how many rows were deleted. */
  async purgeExpired(now: Date): Promise<number> {
    const logins = await this.db.delete(webLogin).where(lte(webLogin.expiresAt, now)).returning();
    const sessions = await this.db.delete(webSession).where(lte(webSession.expiresAt, now)).returning();
    return logins.length + sessions.length;
  }
}
