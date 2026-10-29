-- Star a Want to go place: starred places go to the top of Best match and are highlighted in the list.
-- Imports never touch it; moving a place between lists keeps it.
alter table public.places add column if not exists starred_at timestamptz;
