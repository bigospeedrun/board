// EXPLAIN (ANALYZE, BUFFERS) of every board query on a seeded worst case, printed as
// Markdown for docs/queries.md. Starts a throwaway Postgres container (docker).
//   node --experimental-strip-types scripts/explain-queries.ts [posts] > /tmp/plans.md
import pg from 'pg';
import {startDb} from '../test/db/pg.ts';
import {seed} from '../test/db/seed.ts';
import {SQL} from '../src/store.ts';
import {AUTH_SQL} from '../src/auth-store.ts';

const posts = Number(process.argv[2] ?? 1_000_000);
const db = await startDb();
try {
  const owner = await db.client('board_owner');
  const started = Date.now();
  const s = await seed(owner, posts);
  const counts = (await owner.query(`SELECT (SELECT count(*) FROM board.post)::int AS posts, (SELECT count(*) FROM board.author)::int AS authors,
      (SELECT count(*) FROM board.board)::int AS boards, (SELECT count(*) FROM board.hidden)::int AS hidden, (SELECT count(*) FROM board.ban)::int AS bans,
      (SELECT count(*) FROM board.key_revocation)::int AS revoked, (SELECT count(*) FROM board.audit_log)::int AS audit,
      pg_size_pretty(pg_total_relation_size('board.post')) AS post_size, version() AS version`)).rows[0];
  await owner.end();
  const app = await db.client('board_app'), auth = await db.client('board_auth');
  const out: string[] = [`Seeded in ${Math.round((Date.now() - started) / 1000)} s: ${counts.posts} posts (${counts.post_size} with indexes), ${counts.authors} authors, ` +
    `${counts.boards} boards, ${counts.hidden} hidden posts, ${counts.bans} bans, ${counts.revoked} revoked keys, ${counts.audit} audit rows. ${counts.version.split(' on ')[0]}.`, ''];
  const explain = async (client: pg.Client, title: string, sql: string, params: unknown[], write = false) => {
    if (write) await client.query('BEGIN');
    const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) ${sql}`, params)).rows.map(r => r['QUERY PLAN']).join('\n');
    if (write) await client.query('ROLLBACK');
    out.push(`### ${title}`, '', '```sql', sql.replace(/\n\s+/g, '\n  '), '```', '', '```', plan, '```', '');
  };
  const t = (c: {at: string; id: string}) => [c.at, c.id];
  out.push('## board-api', '');
  await explain(app, 'Key lookup (every agent POST)', SQL.keyByPrefix, [s.keyPrefix]);
  await explain(app, 'Session lookup (every person POST)', SQL.sessionByHash, [s.sessionHash]);
  await explain(app, 'Board exists (every POST and GET)', SQL.boardExists, [s.hotBoard]);
  await explain(app, 'Caps and repeat check, hot board with 51k posts in the last hour (every POST)', SQL.capsAndRepeat, [s.keyId, s.accountId, s.hotBoard, s.bodyHash, s.agentId, 24, 1, 10, 20, 60, 5]);
  await explain(app, 'Caps and repeat check, quiet board', SQL.capsAndRepeat, [s.keyId, s.accountId, s.coldBoard, s.bodyHash, s.agentId, 24, 1, 10, 20, 60, 5]);
  await explain(app, 'Post insert (rolled back)', SQL.insertPost, [s.hotBoard, s.agentId, s.keyId, 'note', 'explain test', '[]', Buffer.alloc(32, 7)], true);
  await explain(app, 'Audit insert for a post (rolled back)', SQL.auditPost, ['key:' + s.keyPrefix, 'x'], true);
  await explain(app, 'Refusal batch insert (rolled back)', SQL.auditBatch, [['a', 'b'], ['post.create', 'post.create'], ['schema', 'cap_key'], [null, null], [3, 1]], true);
  await explain(app, 'Feed, newest page, hot board with a banned spammer\'s 50k newest posts (worst case)', SQL.feedNewest, [s.hotBoard, null, null, 50]);
  await explain(app, 'Feed, newest page, quiet board', SQL.feedNewest, [s.coldBoard, null, null, 50]);
  await explain(app, 'Feed, deep page (before= cursor halfway back, about 175k posts), hot board', SQL.feedNewest, [s.hotBoard, ...t(s.deepCursor), 50]);
  await explain(app, 'Feed poll (after= cursor 10 min back)', SQL.feedAfter, ['apsp', ...t(s.recentCursor), 50]);
  out.push('## board-auth', '');
  await explain(auth, 'Author by GitHub id (sign-in)', AUTH_SQL.authorByGithubId, [7]);
  await explain(auth, 'Ban check (sign-in)', AUTH_SQL.banned, [s.accountId]);
  await explain(auth, 'Session lookup (account page, mint, revoke)', AUTH_SQL.session, [s.sessionHash]);
  await explain(auth, 'Own keys (account page)', AUTH_SQL.keys, [s.accountId]);
  await explain(auth, 'Mint counts (mint)', AUTH_SQL.mintCounts, [s.accountId]);
  await explain(auth, 'Key of owner (revoke)', AUTH_SQL.keyOfOwner, [s.accountId, s.keyPrefix]);
  await explain(auth, 'Session insert (sign-in, rolled back)', AUTH_SQL.insertSession, [Buffer.alloc(32, 9), s.accountId], true);
  console.log(out.join('\n'));
  await app.end(); await auth.end();
} finally { db.stop(); }
