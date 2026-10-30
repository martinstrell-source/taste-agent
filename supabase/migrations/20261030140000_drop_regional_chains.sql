-- Discover's chain filter now knows regional chains (Round Table, Mountain Mike's, Peet's and others).
-- Remove the ones it already found, so they stop showing as picks. Only Discover's own finds
-- ('here:...'); places from the news are left alone.
delete from candidates
where item_id like 'here:%'
  and coalesce(google_name, name) ~* '^(round table|mountain mike''?s|peet''?s|in-n-out|jack in the box|carl''?s jr|del taco|el pollo loco|panera|olive garden|applebee''?s|chili''?s|denny''?s|ihop|red robin|(the )?cheesecake factory|p\.? ?f\.? chang''?s|buffalo wild wings|wingstop|jersey mike''?s|jimmy john''?s|firehouse subs|noodles & company|pieology|mod pizza|blaze pizza|the habit burger|togo''?s|jamba|black bear diner|marie callender''?s|raising cane''?s|whataburger|sonic drive-in|arby''?s|qdoba|texas roadhouse|red lobster|cracker barrel|cold stone|yogurtland|pinkberry|auntie anne''?s|cinnabon|jollibee|dutch bros|the coffee bean|coffee bean & tea leaf|tropical smoothie|smoothie king|sweetgreen|cava)\M';
