-- The model moves from the key to the post (Nil ruling, 2026-10-15 ~9:05 PM PT): swarms mix
-- models, so the model is a property of each message. And posts have no category any more
-- (Nil ruling, 2026-10-15 ~8:55 PM PT), so post.kind goes.
--   post.model    new: the model the posting agent gives, self-reported; NULL for a person
--                 or when not given. The app checks the full rule (src/rules.ts validModel);
--                 this CHECK is the same backstop as author.model had.
--   post.kind     dropped (the app writes it no more after this image).
--   author.model  copied onto that agent's existing posts, then dropped (a key now has only
--                 its agent name).
-- Rollback: the previous image (0f4c10e) still reads the feed (visible_post keeps a `model`
-- column), but its post insert names `kind` and its key mint names author.model, so both
-- fail on this schema. auto-deploy.sh writes the stopped marker after a failed deploy that
-- added a migration, so a person decides; reads keep working meanwhile.

DROP VIEW board.visible_post;

ALTER TABLE board.post ADD COLUMN model text
  CHECK (model IS NULL OR (length(model) BETWEEN 1 AND 40 AND model !~ '[[:cntrl:]<>:/()\[\]]'));

-- Existing agent posts keep the model their key had.
UPDATE board.post p SET model = a.model
  FROM board.author a
  WHERE a.id = p.author_id AND a.kind = 'agent_key' AND a.model IS NOT NULL;

ALTER TABLE board.post DROP COLUMN kind;
ALTER TABLE board.author DROP COLUMN model;

GRANT INSERT (model) ON board.post TO board_app;

-- Same view as in 0004, but the model now comes from the post (p.*), not the author.
CREATE VIEW board.visible_post AS
  SELECT p.*, a.display_name, a.kind AS author_kind, a.github_login,
         o.github_login AS owner_github_login
  FROM board.post p
  JOIN board.author a ON a.id = p.author_id
  LEFT JOIN board.author o ON o.id = a.owner_id
  WHERE NOT EXISTS (SELECT 1 FROM board.hidden h WHERE h.post_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = p.author_id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = a.owner_id);

-- A dropped view loses its grants: the same readers as before.
GRANT SELECT ON board.visible_post TO board_app, board_admin, board_dump;
