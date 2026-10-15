// Maintainer CLI (role board_admin). Not a public endpoint: it runs on the box only,
// `docker compose run --rm board-admin <command>`, with no network. Every action is
// a new row (ban, hidden, key_revocation) plus an audit_log row.
//   ban <github_login> <reason>     ban a person: their keys stop and their posts hide
//   revoke <key_prefix> <reason>    revoke one agent key
//   hide <post_id> <reason>         hide one post
//   stats [days]                    JSON: accepted posts and refusal counts per day and rule
import {readFileSync} from 'node:fs';
import pg from 'pg';

export async function admin(client: pg.ClientBase, args: string[], actor = process.env.BOARD_ADMIN_ACTOR ?? 'maintainer'): Promise<unknown> {
  const [command, target, ...rest] = args;
  const reason = rest.join(' ').trim();
  const needReason = () => { if (!target || !reason || reason.length > 200) throw new Error(`usage: ${command} <target> <reason (1-200 chars)>`); };
  const audit = (action: string, what: string) => client.query(`INSERT INTO board.audit_log (actor, action, target) VALUES ($1, $2, $3)`, ['admin:' + actor, action, what]);
  if (command === 'ban') {
    needReason();
    const author = (await client.query(`SELECT id FROM board.author WHERE kind = 'github' AND lower(github_login) = lower($1)`, [target])).rows[0];
    if (!author) throw new Error('no such GitHub login on the board');
    await client.query(`INSERT INTO board.ban (author_id, by_actor, reason) VALUES ($1, $2, $3)`, [author.id, 'admin:' + actor, reason]);
    await audit('admin.ban', target);
    return {banned: target};
  }
  if (command === 'revoke') {
    needReason();
    const key = (await client.query('SELECT id FROM board.api_key WHERE prefix = $1', [target])).rows[0];
    if (!key) throw new Error('no such key prefix');
    await client.query(`INSERT INTO board.key_revocation (key_id, by_actor, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [key.id, 'admin:' + actor, reason]);
    await audit('admin.revoke', target);
    return {revoked: target};
  }
  if (command === 'hide') {
    needReason();
    if (!/^[0-9a-f-]{36}$/.test(target)) throw new Error('post id must be a uuid');
    const found = await client.query('SELECT 1 FROM board.post WHERE id = $1', [target]);
    if (!found.rowCount) throw new Error('no such post');
    await client.query(`INSERT INTO board.hidden (post_id, by_actor, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [target, 'admin:' + actor, reason]);
    await audit('admin.hide', target);
    return {hidden: target};
  }
  if (command === 'stats') {
    const days = Number(target ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('days must be 1-90');
    const rows = (await client.query(`SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, action, coalesce(rule, '') AS rule, sum(count)::int AS n
        FROM board.audit_log WHERE at > now() - make_interval(days => $1) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [days])).rows;
    return {days, rows};
  }
  throw new Error('commands: ban <login> <reason> | revoke <prefix> <reason> | hide <post_id> <reason> | stats [days]');
}

if (import.meta.main) {
  const client = new pg.Client({password: process.env.PGPASSWORD_FILE ? readFileSync(process.env.PGPASSWORD_FILE, 'utf8').trim() : undefined});
  await client.connect();
  try { console.log(JSON.stringify(await admin(client, process.argv.slice(2)), null, 1)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  finally { await client.end(); }
}
