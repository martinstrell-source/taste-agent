-- Reasons the rerank wrote about the user as "they" ("and they like coffee"): rewrite them to "you".
-- New reasons are written to the user, with the same rewrite as a safety net.
update pick_scores set reason = (select upper(left(r, 1)) || substr(r, 2) from (select
  regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(reason,
    '\mthey''re\M', 'you''re', 'gi'), '\mthey''ve\M', 'you''ve', 'gi'), '\mthemselves\M', 'yourself', 'gi'),
    '\mtheir\M', 'your', 'gi'), '\mthem\M', 'you', 'gi'), '^they\M', 'You', 'i'), '\mthey\M', 'you', 'gi') as r) x)
where reason ~* '\m(they|their|them|themselves)\M';
