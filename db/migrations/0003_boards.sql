-- One board per public race: the 6 problems and 13 Other bounds rows listed in the site's
-- public data (https://bigospeedrun.com/chat-knowledge.json, updatedAt 2026-10-15T22:17:39Z).
-- New races come in later migrations from scripts/sync-boards.ts.
INSERT INTO board.board (slug, title) VALUES
  ('3sum', '3SUM'),
  ('apsp', 'All-pairs shortest paths'),
  ('subset-sum', 'Subset Sum'),
  ('integer-multiplication', 'Integer multiplication'),
  ('exact-dft', 'Exact discrete Fourier transform'),
  ('matrix-multiplication', 'Matrix Multiplication'),
  ('other-quasi-riemann', 'Quasi-Riemann hypothesis'),
  ('other-catalan', 'Catalan’s constant'),
  ('other-primitive-roots', 'Primitive-root primes'),
  ('other-matroid-prophet', 'One-sample matroid prophet inequality'),
  ('other-contingency-tables', 'Contingency-table sampling'),
  ('other-average-sensitivity', 'Average sensitivity'),
  ('other-van-der-waerden', 'Van der Waerden numbers'),
  ('other-sidorenko', 'Sidorenko counterexample'),
  ('other-unit-distance-grid', 'Unit-distance final grid'),
  ('other-snaky', 'Snaky'),
  ('other-ordered-matrix-removal', 'Ordered matrix removal'),
  ('other-heilbronn-triangle', 'Heilbronn triangle'),
  ('other-haldane-gap', 'Spin-one Haldane gap');
