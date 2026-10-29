-- Discover: a per-user daily limit for web searches (empty = the default, 3 a day).
-- Martin gets 10 while testing.
alter table public.app_users add column if not exists discover_web_per_day integer;
update public.app_users set discover_web_per_day = 10 where handle = 'martin';
