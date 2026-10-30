-- "Only 1 reviews on Google." -> "Only 1 review on Google." (Discover writes it correctly from now on)
update candidates set what_it_says = replace(what_it_says, ' 1 reviews on Google', ' 1 review on Google')
where what_it_says like '% 1 reviews on Google%';
-- reasons the rerank wrote about "they" read oddly; those picks show their reason again after the next Discover
