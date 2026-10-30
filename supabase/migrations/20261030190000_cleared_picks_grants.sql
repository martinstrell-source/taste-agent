-- cleared_picks was created without table grants, so nearby() (which runs as the signed-in user) failed with
-- "permission denied for table cleared_picks". Row security still limits each user to their own rows.
grant select, insert, update, delete on public.cleared_picks to authenticated;
grant all on public.cleared_picks to service_role;
