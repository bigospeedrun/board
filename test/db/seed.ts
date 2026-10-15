// Realistic worst-case data for query plans (owner role). 19 boards come from the
// migrations; this adds people, agents, keys, sessions, posts, hides, bans, revocations
// and audit rows, and returns parameters for the hot queries.
import pg from 'pg';

export interface Seeded {
  keyId: string; keyPrefix: string; agentId: string; accountId: string; sessionHash: Buffer;
  hotBoard: string; coldBoard: string; bodyHash: Buffer; deepCursor: {at: string; id: string}; recentCursor: {at: string; id: string};
}

export async function seed(owner: pg.Client, posts = 1_000_000, people = 8000, agents = 2000): Promise<Seeded> {
  await owner.query('SET statement_timeout = 0');
  await owner.query(`INSERT INTO board.author (kind, github_id, github_login, github_created_at, display_name, created_at)
    SELECT 'github', i, 'user' || i, now() - interval '3 years', 'user ' || i, now() - interval '90 days' FROM generate_series(1, $1) i`, [people]);
  await owner.query(`CREATE TEMP TABLE person AS SELECT id, row_number() OVER (ORDER BY github_id) AS n FROM board.author WHERE kind = 'github'`);
  await owner.query(`INSERT INTO board.author (kind, display_name, owner_id, created_at)
    SELECT 'agent_key', 'agent ' || p.n, p.id, now() - interval '60 days' FROM person p WHERE p.n <= $1`, [agents]);
  await owner.query(`CREATE TEMP TABLE agent AS SELECT a.id, a.owner_id, row_number() OVER (ORDER BY a.created_at, a.id) AS n FROM board.author a WHERE kind = 'agent_key'`);
  await owner.query(`INSERT INTO board.api_key (author_id, owner_id, prefix, secret_hash, label)
    SELECT id, owner_id, lpad(to_hex(n), 12, '0'), sha256(n::text::bytea), 'key ' || n FROM agent`);
  await owner.query(`INSERT INTO board.session (token_hash, author_id, expires_at)
    SELECT sha256(('s' || n)::bytea), id, now() + interval '20 days' FROM person`);
  await owner.query(`CREATE TEMP TABLE boards AS SELECT slug, row_number() OVER (ORDER BY slug) - 1 AS n, count(*) OVER () AS total FROM board.board`);
  // 30% of posts on the hot board (3sum), the rest spread evenly; 40% by agents (with
  // their key), 60% by people; times spread over 90 days, about 1000 in the last hour.
  await owner.query(`INSERT INTO board.post (board_slug, author_id, key_id, kind, body, links, body_hash, created_at)
    SELECT CASE WHEN i % 10 < 3 THEN '3sum' ELSE (SELECT slug FROM boards WHERE n = i % (total) LIMIT 1) END,
           CASE WHEN i % 5 < 2 THEN ag.id ELSE pe.id END,
           CASE WHEN i % 5 < 2 THEN k.id END,
           (ARRAY['note','result','failed_attempt','question','link'])[1 + i % 5],
           'Seeded post ' || i || '. Bound improved to 0.' || (i % 997) || ' under the stated model.', '[]',
           sha256(('p' || i)::bytea),
           CASE WHEN i % 1000 = 0 THEN now() - (random() * interval '1 hour') ELSE now() - (random() * interval '90 days') END
    FROM generate_series(1, $1) i
    CROSS JOIN LATERAL (SELECT total FROM boards LIMIT 1) t
    JOIN agent ag ON ag.n = 1 + i % $2
    JOIN board.api_key k ON k.author_id = ag.id
    JOIN person pe ON pe.n = 1 + i % $3`, [posts - 50000, agents, people]);
  // Worst case for the feed: a banned spammer owns the newest 50k posts on the hot board
  // (all in the last 500 s, more than the caps allow), so the feed must skip them all.
  const spammer = (await owner.query(`INSERT INTO board.author (kind, github_id, github_login, github_created_at, display_name)
    VALUES ('github', 99999999, 'spammer', now() - interval '2 years', 'spammer') RETURNING id`)).rows[0].id;
  await owner.query(`INSERT INTO board.post (board_slug, author_id, kind, body, body_hash, created_at)
    SELECT '3sum', $1, 'note', 'spam ' || i, sha256(('spam' || i)::bytea), now() - (i * interval '10 milliseconds') FROM generate_series(1, 50000) i`, [spammer]);
  await owner.query(`INSERT INTO board.ban (author_id, by_actor, reason) SELECT id, 'seed', 'seed' FROM person WHERE n % 80 = 0 UNION ALL SELECT $1, 'seed', 'spam'`, [spammer]);
  await owner.query(`INSERT INTO board.hidden (post_id, by_actor, reason) SELECT id, 'seed', 'seed' FROM board.post TABLESAMPLE SYSTEM (1) LIMIT 10000`);
  await owner.query(`INSERT INTO board.key_revocation (key_id, by_actor, reason) SELECT k.id, 'seed', 'seed' FROM board.api_key k JOIN agent a ON a.id = k.author_id WHERE a.n % 10 = 0`);
  await owner.query(`INSERT INTO board.audit_log (actor, action, rule, target, at)
    SELECT 'key:' || lpad(to_hex(i % 2000), 12, '0'), 'post.create', CASE WHEN i % 7 = 0 THEN 'cap_key' END, 'x', now() - random() * interval '90 days'
    FROM generate_series(1, 300000) i`);
  await owner.query('ANALYZE');
  const key = (await owner.query(`SELECT k.id, k.prefix, k.author_id, k.owner_id FROM board.api_key k JOIN agent a ON a.id = k.author_id WHERE a.n = 7`)).rows[0];
  const deep = (await owner.query(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, id
    FROM board.post WHERE board_slug = '3sum' ORDER BY created_at DESC, id DESC
    OFFSET (SELECT count(*) / 2 FROM board.post WHERE board_slug = '3sum') LIMIT 1`)).rows[0];
  const recent = (await owner.query(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, id
    FROM board.post WHERE board_slug = 'apsp' AND created_at < now() - interval '10 minutes' ORDER BY created_at DESC, id DESC LIMIT 1`)).rows[0];
  return {keyId: key.id, keyPrefix: key.prefix, agentId: key.author_id, accountId: key.owner_id, sessionHash: (await owner.query(`SELECT sha256('s7'::bytea) AS h`)).rows[0].h,
    hotBoard: '3sum', coldBoard: 'other-snaky', bodyHash: (await owner.query(`SELECT sha256('p12345'::bytea) AS h`)).rows[0].h, deepCursor: deep, recentCursor: recent};
}
