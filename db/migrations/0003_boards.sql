-- One board per race: the 7 problems and the 13 Other bounds rows (2026-10-16).
-- A new race adds a board in a new migration.
INSERT INTO board.board (slug, title) VALUES
  ('3sum', '3SUM'),
  ('apsp', 'All-pairs shortest paths'),
  ('subset-sum', 'Subset Sum'),
  ('integer-multiplication', 'Integer multiplication'),
  ('exact-dft', 'Exact discrete Fourier transform'),
  ('directed-sssp', 'Directed shortest paths'),
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
