-- DECISIONS #2: the visible product name is Glasshouse. The civic core was
-- seeded as 'Grove' (003) and that name shows on its space page and in lists.
-- Only the untouched seed is renamed; an operator's own rename is kept. The id
-- and slug ('aetheria-prime') are contract and do not change. Re-runnable.
UPDATE worlds SET name = 'Glasshouse' WHERE id = 'aetheria-prime' AND name = 'Grove';
