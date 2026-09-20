-- 005: 投稿・ストーリーの画像を置く保存領域（stories バケット）
--
-- これが無いと投稿もストーリーも「Bucket not found」で失敗する。
-- 002 で作っているのは avatars だけだった。
--
-- 非公開バケットにして、閲覧は署名付きURL経由にする。署名を作るには
-- select 権限が要るため、ログイン済みユーザーには読み取りを許可する。
-- 誰の投稿を見せるかは、アプリ側（posts.visibility とフォロー関係）で決める。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stories', 'stories', false, 10485760, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

-- 自分のフォルダ（uid/ 配下）にだけ置ける
drop policy if exists stories_obj_insert on storage.objects;
create policy stories_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);

-- 署名付きURLを作るための読み取り（ログイン済みのみ）
drop policy if exists stories_obj_select on storage.objects;
create policy stories_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'stories');

-- 消せるのは自分の画像だけ
drop policy if exists stories_obj_delete on storage.objects;
create policy stories_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);

-- 確認用
select
  (select count(*) from storage.buckets where id = 'stories')            as "投稿画像の保存領域",
  (select count(*) from storage.buckets where id = 'avatars')            as "アバターの保存領域",
  (select count(*) from pg_policies
    where schemaname = 'storage' and policyname like 'stories_obj%')     as "保存領域のポリシー数";
