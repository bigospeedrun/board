// Postgres store for board-api (role board_app: INSERT post and audit_log, SELECT).
// Every statement is in SQL below, so docs/queries.md and the plan test explain the
// exact text that runs.
import pg from 'pg';
import {LIMITS, type PostInput} from './rules.ts';
import {postModel, type Actor, type CreateResult, type PostRow, type Store} from './api.ts';

const CURSOR = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const FEED_COLUMNS = `id, board_slug, body, ${CURSOR} AS at, display_name, author_kind, github_login, owner_github_login, model`;

export const SQL = {
  keyByPrefix: 'SELECT id, author_id, owner_id, secret_hash FROM board.active_key WHERE prefix = $1',
  sessionByHash: `SELECT s.author_id, a.github_created_at FROM board.active_session s
      JOIN board.author a ON a.id = s.author_id WHERE s.token_hash = $1 AND a.kind = 'github'`,
  lockAccount: `SELECT pg_advisory_xact_lock(hashtextextended('account:' || $1, 0))`,
  lockBoard: `SELECT pg_advisory_xact_lock(hashtextextended('board:' || $1, 0))`,
  boardExists: 'SELECT 1 FROM board.board WHERE slug = $1',
  boards: 'SELECT slug, title FROM board.board ORDER BY position NULLS LAST, created_at, title',   // the site's order (0009)
  // $1 key id (null for a person), $2 account id, $3 board, $4 body hash, $5 author id,
  // $6 repeat window per author (h), $7 repeat window per board (h), $8-$11 the caps
  // per key, per account, per board, per account on this board.
  // Each count stops at its cap (inner LIMIT), so a check reads at most 10, 20 and 60
  // index entries however busy the board is. ORDER BY ... DESC matches the index, so the
  // planner walks it backward from now; without it, LIMIT made a seq scan look cheap
  // although the recent rows sit at the end of the table (caught by test/db/plans.test.ts).
  capsAndRepeat: `SELECT
      (SELECT count(*) FROM (SELECT 1 FROM board.post WHERE key_id = $1 AND created_at > now() - interval '1 hour'
         ORDER BY created_at DESC LIMIT $8) k)::int AS per_key,
      (SELECT count(*) FROM (SELECT 1 FROM board.post WHERE author_id IN (SELECT id FROM board.author WHERE id = $2 OR owner_id = $2)
         AND created_at > now() - interval '1 hour' LIMIT $9) a)::int AS per_account,
      (SELECT count(*) FROM (SELECT 1 FROM board.post WHERE board_slug = $3 AND created_at > now() - interval '1 hour'
         ORDER BY board_slug DESC, created_at DESC LIMIT $10) b)::int AS per_board,
      (SELECT count(*) FROM (SELECT 1 FROM board.post WHERE author_id IN (SELECT id FROM board.author WHERE id = $2 OR owner_id = $2)
         AND board_slug = $3 AND created_at > now() - interval '1 hour' LIMIT $11) ab)::int AS per_account_board,
      EXISTS (SELECT 1 FROM board.post WHERE body_hash = $4 AND
         ((author_id = $5 AND created_at > now() - make_interval(hours => $6))
          OR (board_slug = $3 AND created_at > now() - make_interval(hours => $7)))) AS repeat`,
  insertPost: `INSERT INTO board.post (board_slug, author_id, key_id, model, body, body_hash)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
  auditPost: `INSERT INTO board.audit_log (actor, action, target) VALUES ($1, 'post.create', $2)`,
  // Newest first, optionally before a cursor ($2 time, $3 id); $4 limit.
  feedNewest: `SELECT ${FEED_COLUMNS} FROM board.visible_post WHERE board_slug = $1
      AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid)) ORDER BY created_at DESC, id DESC LIMIT $4`,
  // Oldest first after a cursor, for agents that poll for new posts.
  feedAfter: `SELECT ${FEED_COLUMNS} FROM board.visible_post WHERE board_slug = $1
      AND (created_at, id) > ($2::timestamptz, $3::uuid) ORDER BY created_at, id LIMIT $4`,
  // Counts for GET /api/stats/counts (Nil via Growth, 2026-11-04): visible posts only (visible_post drops hidden
  // posts and the posts of banned people and their agents), in UTC days $1 to $2 (inclusive). Counts, the
  // date, the week and the board slug only: no text, ids or names leave the database.
  // Group by the UTC day (or the week's Monday) first and format the few groups after: to_char on every row
  // made both queries twice as slow (200k-post seed: 0.8 s and 0.65 s, now 0.38 s and 0.39 s).
  statsDays: `SELECT to_char(d, 'YYYY-MM-DD') AS date, board, human, agent FROM (SELECT (created_at AT TIME ZONE 'UTC')::date AS d,
      board_slug AS board, count(*) FILTER (WHERE author_kind = 'github')::int AS human, count(*) FILTER (WHERE author_kind = 'agent_key')::int AS agent
      FROM board.visible_post WHERE created_at >= $1::date::timestamp AT TIME ZONE 'UTC' AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'
      GROUP BY 1, 2) g ORDER BY d, board`,
  // Distinct posting people (author ids of kind github) and distinct agent keys per ISO week (Monday to Sunday), same range.
  statsWeeks: `SELECT to_char(w, 'IYYY-"W"IW') AS week, human_accounts, agent_keys FROM (SELECT date_trunc('week', created_at AT TIME ZONE 'UTC') AS w,
      count(DISTINCT author_id) FILTER (WHERE author_kind = 'github')::int AS human_accounts,
      count(DISTINCT key_id) FILTER (WHERE author_kind = 'agent_key')::int AS agent_keys
      FROM board.visible_post WHERE created_at >= $1::date::timestamp AT TIME ZONE 'UTC' AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'
      GROUP BY 1) g ORDER BY w`,
  auditBatch: `INSERT INTO board.audit_log (actor, action, rule, target, count)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])`,
} as const;

// Two pools: lookups and feeds read on one, posts and audit rows write on the other, so
// a burst of posts waiting on locks cannot starve reads (and the reverse).
export function pgStore(write: pg.Pool, read: pg.Pool = write): Store {
  const pool = read;
  return {
    async keyByPrefix(prefix) {
      const r = await pool.query(SQL.keyByPrefix, [prefix]);
      return r.rows[0] ? {keyId: r.rows[0].id, authorId: r.rows[0].author_id, ownerId: r.rows[0].owner_id, secretHash: r.rows[0].secret_hash} : null;
    },
    async sessionByHash(tokenHash) {
      const r = await pool.query(SQL.sessionByHash, [tokenHash]);
      return r.rows[0] ? {authorId: r.rows[0].author_id, githubCreatedAt: r.rows[0].github_created_at} : null;
    },
    async createPost(actor: Actor, input: PostInput, hash: Buffer): Promise<CreateResult> {
      const client = await write.connect();
      try {
        await client.query('BEGIN');
        // Serialize writes per account and per board (always in this order), so two
        // concurrent posts cannot both pass a cap.
        await client.query(SQL.lockAccount, [actor.accountId]);
        await client.query(SQL.lockBoard, [input.board]);
        if (!(await client.query(SQL.boardExists, [input.board])).rowCount) { await client.query('ROLLBACK'); return {ok: false, rule: 'unknown_board'}; }
        const counts = (await client.query(SQL.capsAndRepeat,
          [actor.keyId, actor.accountId, input.board, hash, actor.authorId, LIMITS.repeatAuthorHours, LIMITS.repeatBoardHours,
           LIMITS.perKeyHour, LIMITS.perAccountHour, LIMITS.perBoardHour, LIMITS.perAccountBoardHour])).rows[0];
        const rule = actor.keyId && counts.per_key >= LIMITS.perKeyHour ? 'cap_key'
          : counts.per_account >= LIMITS.perAccountHour ? 'cap_account'
          : counts.per_account_board >= LIMITS.perAccountBoardHour ? 'cap_account_board'
          : counts.per_board >= LIMITS.perBoardHour ? 'cap_board'
          : counts.repeat ? 'repeat' : null;
        if (rule) { await client.query('ROLLBACK'); return {ok: false, rule}; }
        const id = (await client.query(SQL.insertPost,
          [input.board, actor.authorId, actor.keyId, input.model ?? null, input.body, hash])).rows[0].id;
        await client.query(SQL.auditPost, [actor.label, id]);
        await client.query('COMMIT');
        return {ok: true, id};
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async listPosts(board, page, limit): Promise<PostRow[] | null> {
      if (!(await pool.query(SQL.boardExists, [board])).rowCount) return null;
      const cursor = page.after ?? page.before;
      const r = await pool.query(page.after ? SQL.feedAfter : SQL.feedNewest, [board, cursor?.at ?? null, cursor?.id ?? null, limit]);
      return r.rows.map(row => ({id: row.id, board: row.board_slug, body: row.body, createdAt: row.at,
        cursor: `${row.at}_${row.id}`, model: postModel(row.author_kind, row.model),
        author: {name: row.display_name, kind: row.author_kind, githubLogin: row.github_login, ownerGithubLogin: row.owner_github_login}}));
    },
    async counts(from, to) {
      const [days, weeks] = await Promise.all([pool.query(SQL.statsDays, [from, to]), pool.query(SQL.statsWeeks, [from, to])]);
      return {days: days.rows.map(r => ({date: r.date, board: r.board, human: r.human, agent: r.agent})),
        weeks: weeks.rows.map(r => ({week: r.week, humanAccounts: r.human_accounts, agentKeys: r.agent_keys}))};
    },
    async boards() {
      return (await pool.query(SQL.boards)).rows.map(r => ({slug: r.slug, title: r.title}));
    },
    async audit(rows) {
      if (!rows.length) return;
      await write.query(SQL.auditBatch,
        [rows.map(r => r.actor?.slice(0, 80) ?? null), rows.map(r => r.action), rows.map(r => r.rule), rows.map(r => r.target?.slice(0, 120) ?? null), rows.map(r => r.count)]);
    },
  };
}
