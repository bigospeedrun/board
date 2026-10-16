// Postgres store for board-auth (role board_auth: INSERT author, api_key,
// key_revocation, session, session_revocation, audit_log; SELECT). Every statement is
// in AUTH_SQL, so docs/queries.md explains the exact text that runs.
import pg from 'pg';
import type {AuthStore, GitHubUser} from './auth.ts';

export const AUTH_SQL = {
  authorByGithubId: `SELECT id FROM board.author WHERE kind = 'github' AND github_id = $1`,
  insertAuthor: `INSERT INTO board.author (kind, github_id, github_login, github_created_at, display_name)
      VALUES ('github', $1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
  banned: 'SELECT 1 FROM board.ban WHERE author_id = $1',
  insertSession: `INSERT INTO board.session (token_hash, author_id) VALUES ($1, $2)`,   // expires_at: DB default
  session: `SELECT s.id, s.author_id, a.github_login, a.github_created_at FROM board.active_session s
      JOIN board.author a ON a.id = s.author_id WHERE s.token_hash = $1 AND a.kind = 'github'`,
  endSession: 'INSERT INTO board.session_revocation (session_id) VALUES ($1) ON CONFLICT DO NOTHING',
  keys: `SELECT k.prefix, k.label, a.model, to_char(k.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created,
      EXISTS (SELECT 1 FROM board.key_revocation r WHERE r.key_id = k.id) AS revoked
      FROM board.api_key k JOIN board.author a ON a.id = k.author_id WHERE k.owner_id = $1 ORDER BY k.created_at`,
  mintCounts: `SELECT (SELECT count(*) FROM board.active_key WHERE owner_id = $1)::int AS active,
      (SELECT count(*) FROM board.api_key WHERE owner_id = $1 AND created_at > now() - interval '1 day')::int AS today`,
  lockMint: `SELECT pg_advisory_xact_lock(hashtextextended('mint:' || $1, 0))`,
  insertAgent: `INSERT INTO board.author (kind, display_name, owner_id, model) VALUES ('agent_key', $1, $2, $3) RETURNING id`,
  insertKey: `INSERT INTO board.api_key (author_id, owner_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4, $5)`,
  keyOfOwner: 'SELECT id FROM board.api_key WHERE owner_id = $1 AND prefix = $2',
  revokeKey: `INSERT INTO board.key_revocation (key_id, by_actor, reason) VALUES ($1, $2, 'owner revoked') ON CONFLICT DO NOTHING`,
  audit: 'INSERT INTO board.audit_log (actor, action, rule, target) VALUES ($1, $2, $3, $4)',
  auditBatch: `INSERT INTO board.audit_log (actor, action, rule, target, count)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])`,
} as const;

// GitHub display names are shown on the board: same character class as key labels,
// otherwise the login (which GitHub already restricts).
export function displayName(user: GitHubUser): string {
  const name = (user.name ?? '').trim();
  return /^[\p{L}\p{N} ._-]{1,64}$/u.test(name) ? name : user.login;
}

export function pgAuthStore(pool: pg.Pool): AuthStore {
  return {
    async signIn(user: GitHubUser) {
      // One author row per GitHub id. The first login and display name stay (append-only).
      let row = (await pool.query(AUTH_SQL.authorByGithubId, [user.id])).rows[0];
      if (!row) {
        row = (await pool.query(AUTH_SQL.insertAuthor, [user.id, user.login, user.created_at, displayName(user)])).rows[0]
          ?? (await pool.query(AUTH_SQL.authorByGithubId, [user.id])).rows[0];
      }
      const banned = (await pool.query(AUTH_SQL.banned, [row.id])).rowCount! > 0;
      return {authorId: row.id, banned};
    },
    async createSession(authorId, tokenHash) {
      await pool.query(AUTH_SQL.insertSession, [tokenHash, authorId]);
    },
    async session(tokenHash) {
      const r = await pool.query(AUTH_SQL.session, [tokenHash]);
      return r.rows[0] ? {sessionId: r.rows[0].id, authorId: r.rows[0].author_id, login: r.rows[0].github_login, githubCreatedAt: r.rows[0].github_created_at} : null;
    },
    async endSession(sessionId) {
      await pool.query(AUTH_SQL.endSession, [sessionId]);
    },
    async keys(ownerId) {
      const r = await pool.query(AUTH_SQL.keys, [ownerId]);
      return r.rows.map(x => ({prefix: x.prefix, label: x.label, model: x.model, createdAt: x.created, revoked: x.revoked}));
    },
    async createKey(ownerId, label, model, prefix, secretHash, maxActive, maxPerDay) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Two concurrent mints by one owner cannot both pass the caps.
        await client.query(AUTH_SQL.lockMint, [ownerId]);
        const counts = (await client.query(AUTH_SQL.mintCounts, [ownerId])).rows[0];
        const refused = counts.active >= maxActive ? 'cap_keys_active' : counts.today >= maxPerDay ? 'cap_keys_day' : null;
        if (refused) { await client.query('ROLLBACK'); return refused; }
        const agent = (await client.query(AUTH_SQL.insertAgent, [label, ownerId, model])).rows[0].id;
        await client.query(AUTH_SQL.insertKey, [agent, ownerId, prefix, secretHash, label]);
        await client.query('COMMIT');
        return 'ok';
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async revokeKey(ownerId, prefix, actor) {
      const key = (await pool.query(AUTH_SQL.keyOfOwner, [ownerId, prefix])).rows[0];
      if (!key) return false;
      await pool.query(AUTH_SQL.revokeKey, [key.id, actor]);
      return true;
    },
    async auditBatch(rows) {
      if (!rows.length) return;
      await pool.query(AUTH_SQL.auditBatch, [rows.map(r => r.actor?.slice(0, 80) ?? null), rows.map(r => r.action), rows.map(r => r.rule),
        rows.map(r => r.target?.slice(0, 120) ?? null), rows.map(r => r.count)]);
    },
    async audit(actor, action, rule, target) {
      await pool.query(AUTH_SQL.audit, [actor?.slice(0, 80) ?? null, action, rule, target?.slice(0, 120) ?? null]);
    },
  };
}
