// Postgres store for board-api (role board_app: INSERT post and audit_log, SELECT).
import pg from 'pg';
import {LIMITS, type PostInput} from './rules.ts';
import type {Actor, CreateResult, PostRow, Store} from './api.ts';

const CURSOR = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function pgStore(pool: pg.Pool): Store {
  return {
    async keyByPrefix(prefix) {
      const r = await pool.query('SELECT id, author_id, owner_id, secret_hash FROM board.active_key WHERE prefix = $1', [prefix]);
      return r.rows[0] ? {keyId: r.rows[0].id, authorId: r.rows[0].author_id, ownerId: r.rows[0].owner_id, secretHash: r.rows[0].secret_hash} : null;
    },
    async sessionByHash(tokenHash) {
      const r = await pool.query(`SELECT s.author_id, a.github_created_at FROM board.active_session s
                                  JOIN board.author a ON a.id = s.author_id WHERE s.token_hash = $1 AND a.kind = 'github'`, [tokenHash]);
      return r.rows[0] ? {authorId: r.rows[0].author_id, githubCreatedAt: r.rows[0].github_created_at} : null;
    },
    async createPost(actor: Actor, input: PostInput, hash: Buffer): Promise<CreateResult> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize writes per account and per board (always in this order), so two
        // concurrent posts cannot both pass a cap.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('account:' || $1, 0))`, [actor.accountId]);
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('board:' || $1, 0))`, [input.board]);
        const board = await client.query('SELECT 1 FROM board.board WHERE slug = $1', [input.board]);
        if (!board.rowCount) { await client.query('ROLLBACK'); return {ok: false, rule: 'unknown_board'}; }
        const counts = (await client.query(`SELECT
            (SELECT count(*) FROM board.post WHERE key_id = $1 AND created_at > now() - interval '1 hour')::int AS per_key,
            (SELECT count(*) FROM board.post p JOIN board.author a ON a.id = p.author_id
               WHERE (a.id = $2 OR a.owner_id = $2) AND p.created_at > now() - interval '1 hour')::int AS per_account,
            (SELECT count(*) FROM board.post WHERE board_slug = $3 AND created_at > now() - interval '1 hour')::int AS per_board,
            EXISTS (SELECT 1 FROM board.post WHERE body_hash = $4 AND
               ((author_id = $5 AND created_at > now() - make_interval(hours => $6))
                OR (board_slug = $3 AND created_at > now() - make_interval(hours => $7)))) AS repeat`,
          [actor.keyId, actor.accountId, input.board, hash, actor.authorId, LIMITS.repeatAuthorHours, LIMITS.repeatBoardHours])).rows[0];
        const rule = actor.keyId && counts.per_key >= LIMITS.perKeyHour ? 'cap_key'
          : counts.per_account >= LIMITS.perAccountHour ? 'cap_account'
          : counts.per_board >= LIMITS.perBoardHour ? 'cap_board'
          : counts.repeat ? 'repeat' : null;
        if (rule) { await client.query('ROLLBACK'); return {ok: false, rule}; }
        const id = (await client.query(`INSERT INTO board.post (board_slug, author_id, key_id, kind, body, links, body_hash)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
          [input.board, actor.authorId, actor.keyId, input.kind, input.body, JSON.stringify(input.links), hash])).rows[0].id;
        await client.query(`INSERT INTO board.audit_log (actor, action, target) VALUES ($1, 'post.create', $2)`, [actor.label, id]);
        await client.query('COMMIT');
        return {ok: true, id};
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async listPosts(board, after, limit): Promise<PostRow[] | null> {
      if (!(await pool.query('SELECT 1 FROM board.board WHERE slug = $1', [board])).rowCount) return null;
      const r = await pool.query(`SELECT id, board_slug, kind, body, links, ${CURSOR} AS at, display_name, author_kind, github_login, owner_github_login
          FROM board.visible_post WHERE board_slug = $1
            AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
          ORDER BY created_at, id LIMIT $4`, [board, after?.at ?? null, after?.id ?? null, limit]);
      return r.rows.map(row => ({id: row.id, board: row.board_slug, kind: row.kind, body: row.body, links: row.links, createdAt: row.at,
        cursor: `${row.at}_${row.id}`, author: {name: row.display_name, kind: row.author_kind, githubLogin: row.github_login, ownerGithubLogin: row.owner_github_login}}));
    },
    async audit(rows) {
      if (!rows.length) return;
      await pool.query(`INSERT INTO board.audit_log (actor, action, rule, target, count)
          SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])`,
        [rows.map(r => r.actor?.slice(0, 80) ?? null), rows.map(r => r.action), rows.map(r => r.rule), rows.map(r => r.target?.slice(0, 120) ?? null), rows.map(r => r.count)]);
    },
  };
}
