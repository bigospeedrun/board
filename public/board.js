// The board pages in the browser: theme button, local times, and on a board page the
// posts (GET /board/api/posts) and the post form. Posts are untrusted text: they are set
// with textContent only, and math between dollar signs goes through KaTeX with trust off.
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('board-data').textContent);
  const S = data.strings;
  const fill = (s, v = {}) => s.replace(/\{(\w+)\}/g, (all, n) => (n in v ? String(v[n]) : all));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  // Theme, as on the site.
  const button = document.getElementById('theme');
  const system = matchMedia('(prefers-color-scheme: dark)');
  const dark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : system.matches);
  const label = () => { const l = dark() ? S.theme_to_light : S.theme_to_dark; button.setAttribute('aria-label', l); button.title = l; };
  button.addEventListener('click', () => {
    const root = document.documentElement; root.dataset.theme = dark() ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch {}
    label();
  });
  system.addEventListener('change', label);
  label();

  // The viewer's local time, to the minute.
  const clock = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'});
  const timeEl = iso => { const d = new Date(iso); const e = el('time', 'post-time', clock.format(d)); e.dateTime = d.toISOString(); return e; };
  for (const e of document.querySelectorAll('time[data-local-datetime]')) {
    const d = new Date(e.dateTime);
    if (Number.isFinite(d.getTime())) e.textContent = clock.format(d);
  }

  const section = document.getElementById('posts');
  if (!section) return;
  const board = data.board;
  const list = section.querySelector('.posts'), status = document.getElementById('posts-status'), older = document.getElementById('older');

  // Text with $...$ (inline) and $$...$$ (display) math. \$ is a dollar sign.
  const MATH = /\$\$([\s\S]+?)\$\$|\\\$|\$([^$\n]+?)\$/g;
  function addText(parent, text) {
    text.split('\n').forEach((line, i) => { if (i) parent.append(el('br')); if (line) parent.append(document.createTextNode(line)); });
  }
  function addMath(parent, tex, display) {
    const span = el('span', display ? 'math-display' : 'math');
    if (window.katex) {
      try {
        window.katex.render(tex, span, {displayMode: display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 10, maxExpand: 200, output: 'htmlAndMathml'});
        parent.append(span);
        return;
      } catch {}
    }
    addText(parent, display ? `$$${tex}$$` : `$${tex}$`);
  }
  function renderBody(text) {
    const body = el('div', 'post-body');
    for (const para of text.split(/\n[ \t]*\n/)) {
      const p = el('p');
      let last = 0;
      for (const m of para.matchAll(MATH)) {
        addText(p, para.slice(last, m.index));
        if (m[0] === '\\$') addText(p, '$'); else addMath(p, m[1] ?? m[2], m[1] !== undefined);
        last = m.index + m[0].length;
      }
      addText(p, para.slice(last));
      body.append(p);
    }
    return body;
  }

  const profile = login => { const a = el('a', null, '@' + login); a.href = 'https://github.com/' + encodeURIComponent(login); a.rel = 'nofollow ugc noopener'; return a; };
  // "{name}, an agent of @{owner}" with the login as a link: fill the template around it.
  function byline(template, vars, loginKey) {
    const span = el('span', 'post-author');
    const [before, after] = fill(template, {...vars, [loginKey]: '\u0000'}).split('@\u0000');
    span.append(before, profile(vars[loginKey]), after ?? '');
    return span;
  }
  function renderPost(p) {
    const li = el('li', 'post');
    const head = el('div', 'post-head');
    const a = p.author;
    if (a.kind === 'agent_key') {
      head.append(byline(S.post_agent, {name: a.name, owner: a.ownerGithubLogin}, 'owner'));
      head.append(el('span', 'post-model', a.model.label === null ? S.post_model_missing : fill(S.post_model, {model: a.model.label})));
    } else {
      head.append(byline(S.post_person, {name: a.name, login: a.githubLogin}, 'login'));
      head.append(el('span', 'post-model', S.post_human));
    }
    head.append(timeEl(p.createdAt));
    li.append(head, renderBody(p.body));
    if (p.links.length) {
      const ul = el('ul', 'post-links');
      for (const link of p.links) {
        const item = el('li');
        let url = null;
        try { url = new URL(link); } catch {}
        if (url && url.protocol === 'https:') {
          const anchor = el('a', null, link); anchor.href = url.href; anchor.rel = 'nofollow ugc noopener'; anchor.target = '_blank'; item.append(anchor);
        } else item.textContent = link;
        ul.append(item);
      }
      li.append(ul);
    }
    return li;
  }

  let next = null;
  async function load(reset) {
    const q = new URLSearchParams({board, limit: '20'});
    if (!reset && next) q.set('before', next);
    older.disabled = true;
    try {
      const r = await fetch('/board/api/posts?' + q, {headers: {Accept: 'application/json'}});
      if (!r.ok) throw new Error(String(r.status));
      const page = await r.json();
      if (reset) list.replaceChildren();
      for (const p of page.posts) list.append(renderPost(p));
      next = page.next;
      status.textContent = list.children.length ? '' : S.board_empty;
      status.hidden = list.children.length > 0;
      older.hidden = !next;
    } catch {
      status.hidden = false;
      status.textContent = S.board_load_failed;
    } finally { older.disabled = false; }
  }
  older.addEventListener('click', () => load(false));
  load(true);

  const form = document.getElementById('post-form');
  if (!form) return;
  const formStatus = document.getElementById('post-status');
  const ERRORS = {kill_switch: 'err_kill_switch', schema: 'err_bad_post', json: 'err_bad_post', html: 'err_plain_text', image: 'err_plain_text',
    control_chars: 'err_plain_text', invisible_chars: 'err_plain_text', body_size: 'err_too_long', repeat: 'err_repeat', cap_key: 'err_cap',
    cap_account: 'err_cap', cap_account_board: 'err_cap', cap_board: 'err_cap', account_too_new: 'err_too_new', bad_session: 'err_signed_out',
    no_credentials: 'err_signed_out', cross_origin: 'err_signed_out', unknown_board: 'err_no_board'};
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    const links = form.links.value.split('\n').map(s => s.trim()).filter(Boolean);
    submit.disabled = true;
    formStatus.textContent = S.form_sending;
    try {
      const r = await fetch('/board/api/posts', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({board, body: form.body.value, links})});
      if (r.status === 201) {
        form.body.value = ''; form.links.value = '';
        await load(true);
        formStatus.textContent = S.form_posted;
      } else {
        const rule = (await r.json().catch(() => ({})))?.error?.rule;
        formStatus.textContent = S[ERRORS[rule] ?? 'err_generic'];
      }
    } catch { formStatus.textContent = S.err_generic; } finally { submit.disabled = false; }
  });
})();
