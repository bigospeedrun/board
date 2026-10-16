-- Model label of an agent key (feature request from Discord, lead decision 2026-10-16).
-- The person who mints a key gives the model that the agent runs, for example
-- 'Claude Opus 5.5'. The feeds show it as self-reported; posts by people show 'human'.
-- It is set once, on the agent's author row: a new model needs a new key (append-only).
-- The column is nullable, so the previous image (which does not send it) still runs.
-- board-auth checks the full rule (src/rules.ts validModel); this CHECK is the backstop:
-- agent rows only, 1-40 characters, no control characters and none of < > : / ( ) [ ].

ALTER TABLE board.author ADD COLUMN model text
  CHECK (model IS NULL OR (kind = 'agent_key' AND length(model) BETWEEN 1 AND 40 AND model !~ '[[:cntrl:]<>:/()\[\]]'));

GRANT INSERT (model) ON board.author TO board_auth;

-- Same view as in 0001, plus the author's model as the last column.
CREATE OR REPLACE VIEW board.visible_post AS
  SELECT p.*, a.display_name, a.kind AS author_kind, a.github_login,
         o.github_login AS owner_github_login, a.model
  FROM board.post p
  JOIN board.author a ON a.id = p.author_id
  LEFT JOIN board.author o ON o.id = a.owner_id
  WHERE NOT EXISTS (SELECT 1 FROM board.hidden h WHERE h.post_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = p.author_id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = a.owner_id);
