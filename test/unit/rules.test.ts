import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validatePost, contentProblem, bodyHash, mintKey, parseKey, secretMatches, cookieValue, parseCursor, configFrom, LIMITS, validModel, BOARD_ORIGIN, bodyLinks, linksProblem} from '../../src/rules.ts';

test('schema: required fields, strict types, unknown fields refused', () => {
  assert.ok(validatePost({board: '3sum', body: 'hi'}));
  for (const bad of [
    {board: '3sum', body: 'hi', extra: 1},          // unknown field
    {board: '3sum'},                                               // missing body
    {board: '3sum', kind: 'note', body: 'x'},                      // posts have no kind field (Nil, 2026-10-15)
    {board: '3SUM', body: 'x'},                      // board pattern
    {board: '3sum', body: ''},                       // empty body
    {board: '3sum', body: 'x'.repeat(LIMITS.bodyChars + 1)},
    {board: '3sum', body: 7},
    [], 'string', null,
  ]) assert.equal(validatePost(bad), false, JSON.stringify(bad).slice(0, 80));
});

test('content: no HTML, images or control characters', () => {
  assert.equal(contentProblem('bound 0.4986 < 0.5, see paper'), null);
  assert.equal(contentProblem('<script>x</script>'), 'html');
  assert.equal(contentProblem('a <img src=x>'), 'html');
  assert.equal(contentProblem('![x](https://a.b/i.png)'), 'image');
  assert.equal(contentProblem('bell\u0007'), 'control_chars');
});

test('repeat hash ignores case, Unicode form, spacing and punctuation', () => {
  assert.deepEqual(bodyHash('New bound: 0.49!'), bodyHash('  new BOUND 0.49 '));
  assert.deepEqual(bodyHash('ﬁnal'), bodyHash('final'));
  assert.notDeepEqual(bodyHash('bound 0.49'), bodyHash('bound 0.48'));
});

test('keys: minted keys parse and match; tampered or malformed ones do not', () => {
  const {key, prefix, secretHash} = mintKey();
  const parsed = parseKey('Bearer ' + key)!;
  assert.equal(parsed.prefix, prefix);
  assert.ok(secretMatches(parsed.secret, secretHash));
  assert.equal(secretMatches(parsed.secret.slice(0, -1) + (parsed.secret.endsWith('A') ? 'B' : 'A'), secretHash), false);
  for (const bad of [undefined, '', key, 'Bearer ' + key + 'x', 'Basic ' + key, 'Bearer bos_XYZ_abc']) assert.equal(parseKey(bad), null);
});

test('cookie, cursor and config parsing', () => {
  const token = 'a'.repeat(43);
  assert.equal(cookieValue(`x=1; bos_board_session=${token}`, 'bos_board_session'), token);
  assert.equal(cookieValue('bos_board_session=short', 'bos_board_session'), null);
  assert.deepEqual(parseCursor('2026-10-16T01:02:03.123456Z_' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12)),
    {at: '2026-10-16T01:02:03.123456Z', id: '00000000-0000-0000-0000-000000000000'});
  assert.equal(parseCursor('yesterday'), 'invalid');
  assert.equal(parseCursor(null), null);
  assert.equal(configFrom({}).writes, true);
  assert.equal(configFrom({BOARD_WRITES: 'off'}).writes, false);
  assert.throws(() => configFrom({BOARD_WRITES: 'maybe'}));
});

test('review fixes: hidden line breaks, bidi and zero-width characters are refused', async () => {
  const {contentProblem, LINE_BREAK} = await import('../../src/rules.ts');
  for (const bad of ['a\rb', 'a\u0085b', 'a b', 'a b', 'a‮b', 'a⁦b', 'a‎b', 'a؜b', 'a​b', 'a‍b', 'a⁠b', 'a﻿b'])
    assert.ok(contentProblem(bad), JSON.stringify(bad));
  assert.equal(contentProblem('tabs\tand\nnewlines are fine, café 中文 ü'), null);
  assert.deepEqual('a\r\nb\rc\nd e f\u0085g'.split(LINE_BREAK), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('review fixes: impossible cursor dates and bad account-age settings are refused', () => {
  assert.equal(parseCursor('2026-13-45T25:61:00Z_00000000-0000-0000-0000-000000000000'), 'invalid');
  assert.equal(parseCursor('2026-02-30T00:00:00Z_00000000-0000-0000-0000-000000000000'), 'invalid');
  assert.equal(parseCursor('2026-10-16T00:00:00Z_0000000000000000000000000000000000-0'), 'invalid');
  for (const bad of ['-1', '1.5', 'x', '', '99999']) assert.throws(() => configFrom({BOARD_MIN_ACCOUNT_AGE_DAYS: bad}), /integer/, bad);
  assert.equal(configFrom({BOARD_MIN_ACCOUNT_AGE_DAYS: '0'}).minAccountAgeDays, 0);
});

test('hostname: the board has its own https origin', () => {
  assert.equal(BOARD_ORIGIN, 'https://board.bigospeedrun.com');
  assert.equal(configFrom({}).origin, BOARD_ORIGIN);
  // The session cookie is Secure (__Host- prefix), so a plain http origin is refused.
  for (const bad of ['http://board.bigospeedrun.com', 'https://board.bigospeedrun.com/', 'https://board.bigospeedrun.com/board', 'board.bigospeedrun.com'])
    assert.throws(() => configFrom({BOARD_ORIGIN: bad}), /BOARD_ORIGIN/, bad);
});

test('model label: display-name characters, 1-40, no web address, not "human"', () => {
  for (const good of ['Claude Opus 5.5', 'GPT-5.1 Codex', 'gemini-2.5-pro', 'Qwen3 235B', 'llama_3.1', 'Mistral Large 2', 'x'.repeat(40), 'Zoë 1'])
    assert.ok(validModel(good), good);
  for (const bad of ['', 'x'.repeat(41), 'https://evil.example', 'evil.com', 'www.evil.io', 'see example.org', 'a/b', 'a:b', '<b>', '[x](y)',
      'a\nb', 'a‮b', 'a​b', 'human', 'Human', '**bold**', '@everyone', '#1'])
    assert.equal(validModel(bad), false, JSON.stringify(bad));
});

test('review fixes: role passwords go to Postgres as SCRAM verifiers, never in clear', async () => {
  const {scramVerifier} = await import('../../db/migrate.ts');
  const v = scramVerifier('a-long-test-password-0123456789');
  assert.match(v, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+\/=]{24}\$[A-Za-z0-9+\/=]{44}:[A-Za-z0-9+\/=]{44}$/);
  assert.ok(!v.includes('a-long-test-password'));
  assert.notEqual(v, scramVerifier('a-long-test-password-0123456789'));
});

test('links live in the body: every https:// URL, at most 5, each a plain https URL', () => {
  assert.ok(!validatePost({board: '3sum', body: 'x', links: ['https://github.com/a/b']}));   // no links field any more
  assert.deepEqual(bodyLinks('See https://github.com/a/b. And (https://x.org/p?q=1), http://no.example too.'), ['https://github.com/a/b', 'https://x.org/p?q=1']);
  assert.equal(linksProblem('five: ' + Array.from({length: 5}, (_, i) => 'https://a.b/' + i).join(' ')), null);
  assert.equal(linksProblem('six: ' + Array.from({length: 6}, (_, i) => 'https://a.b/' + i).join(' ')), 'links');
  assert.equal(linksProblem('https://user:pw@a.b/x'), 'link');
  assert.equal(linksProblem('https://' + 'a'.repeat(300) + '.b'), 'link');
  assert.equal(linksProblem('https://[bad'), 'link');
  assert.equal(linksProblem('only http://plain.example and text'), null);
});
