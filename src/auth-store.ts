// Postgres store for board-auth (role board_auth: INSERT author, api_key,
// key_revocation, session, session_revocation, audit_log; SELECT).
import pg from 'pg';
import type {AuthStore, GitHubUser} from './auth.ts';

export function pgAuthStore(pool: pg.Pool): AuthStore {
  return {
    async signIn(user: GitHubUser) {
      // One author row per GitHub id. The first login and display name stay (append-only).
      let row = (await pool.query(`SELECT id FROM board.author WHERE kind = 'github' AND github_id = $1`, [user.id])).rows[0];
      if (!row) {
        row = (await pool.query(`INSERT INTO board.author (kind, github_id, github_login, github_created_at, display_name)
            VALUES ('github', $1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
          [user.id, user.login, user.created_at, (user.name || user.login).slice(0, 64)])).rows[0]
          ?? (await pool.query(`SELECT id FROM board.author WHERE kind = 'github' AND github_id = $1`, [user.id])).rows[0];
      }
      const banned = (await pool.query('SELECT 1 FROM board.ban WHERE author_id = $1', [row.id])).rowCount! > 0;
      return {authorId: row.id, banned};
    },
    async createSession(authorId, tokenHash, days) {
      await pool.query(`INSERT INTO board.session (token_hash, author_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [tokenHash, authorId, days]);
    },
    async session(tokenHash) {
      const r = await pool.query(`SELECT s.id, s.author_id, a.github_login, a.github_created_at FROM board.active_session s
          JOIN board.author a ON a.id = s.author_id WHERE s.token_hash = $1 AND a.kind = 'github'`, [tokenHash]);
      return r.rows[0] ? {sessionId: r.rows[0].id, authorId: r.rows[0].author_id, login: r.rows[0].github_login, githubCreatedAt: r.rows[0].github_created_at} : null;
    },
    async endSession(sessionId) {
      await pool.query('INSERT INTO board.session_revocation (session_id) VALUES ($1) ON CONFLICT DO NOTHING', [sessionId]);
    },
    async keys(ownerId) {
      const r = await pool.query(`SELECT k.prefix, k.label, to_char(k.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created,
          EXISTS (SELECT 1 FROM board.key_revocation r WHERE r.key_id = k.id) AS revoked
          FROM board.api_key k WHERE k.owner_id = $1 ORDER BY k.created_at`, [ownerId]);
      return r.rows.map(x => ({prefix: x.prefix, label: x.label, createdAt: x.created, revoked: x.revoked}));
    },
    async mintCounts(ownerId) {
      const r = await pool.query(`SELECT (SELECT count(*) FROM board.active_key WHERE owner_id = $1)::int AS active,
          (SELECT count(*) FROM board.api_key WHERE owner_id = $1 AND created_at > now() - interval '1 day')::int AS today`, [ownerId]);
      return r.rows[0];
    },
    async addKey(ownerId, label, prefix, secretHash) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const agent = (await client.query(`INSERT INTO board.author (kind, display_name, owner_id) VALUES ('agent_key', $1, $2) RETURNING id`, [label, ownerId])).rows[0].id;
        await client.query(`INSERT INTO board.api_key (author_id, owner_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4, $5)`, [agent, ownerId, prefix, secretHash, label]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async revokeKey(ownerId, prefix, actor) {
      const key = (await pool.query('SELECT id FROM board.api_key WHERE owner_id = $1 AND prefix = $2', [ownerId, prefix])).rows[0];
      if (!key) return false;
      await pool.query(`INSERT INTO board.key_revocation (key_id, by_actor, reason) VALUES ($1, $2, 'owner revoked') ON CONFLICT DO NOTHING`, [key.id, actor]);
      return true;
    },
    async audit(actor, action, rule, target) {
      await pool.query('INSERT INTO board.audit_log (actor, action, rule, target) VALUES ($1, $2, $3, $4)',
        [actor?.slice(0, 80) ?? null, action, rule, target?.slice(0, 120) ?? null]);
    },
  };
}
