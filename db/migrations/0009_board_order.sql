-- The board list at / follows the site's order (BOS Lead Dev for Nil, 2026-10-16): the six
-- problems in the order of the site's Problems menu, then the Other bounds rows in the
-- site's order. position is set only by migrations (the app roles cannot update it);
-- scripts/sync-boards.ts states the whole order again in each migration it writes, so a
-- new race lands in its place. The order below is the site's at a66107b (its public
-- chat-knowledge.json lists the problems in the menu order from that commit on).
ALTER TABLE board.board ADD COLUMN position integer CHECK (position >= 1);

-- Board order: the site's order (scripts/sync-boards.ts).
UPDATE board.board SET position = NULL;
UPDATE board.board b SET position = o.position FROM (VALUES
  ('integer-multiplication', 1),
  ('matrix-multiplication', 2),
  ('exact-dft', 3),
  ('3sum', 4),
  ('apsp', 5),
  ('subset-sum', 6),
  ('other-quasi-riemann', 7),
  ('other-catalan', 8),
  ('other-primitive-roots', 9),
  ('other-matroid-prophet', 10),
  ('other-contingency-tables', 11),
  ('other-average-sensitivity', 12),
  ('other-van-der-waerden', 13),
  ('other-sidorenko', 14),
  ('other-unit-distance-grid', 15),
  ('other-snaky', 16),
  ('other-ordered-matrix-removal', 17),
  ('other-heilbronn-triangle', 18),
  ('other-haldane-gap', 19)
) AS o(slug, position) WHERE b.slug = o.slug;
