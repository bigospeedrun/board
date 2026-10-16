-- No compatibility for pre-launch clients (Nil ruling, 2026-10-15 ~9:45 PM PT): the
-- constant `links` column that 0006 kept in visible_post for the previous image goes.
DROP VIEW board.visible_post;
CREATE VIEW board.visible_post AS
  SELECT p.*, a.display_name, a.kind AS author_kind, a.github_login,
         o.github_login AS owner_github_login
  FROM board.post p
  JOIN board.author a ON a.id = p.author_id
  LEFT JOIN board.author o ON o.id = a.owner_id
  WHERE NOT EXISTS (SELECT 1 FROM board.hidden h WHERE h.post_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = p.author_id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = a.owner_id);
GRANT SELECT ON board.visible_post TO board_app, board_admin, board_dump;
