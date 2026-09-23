-- 視聴者ごとの記録（issue #61）
--
-- 日時は 0001〜0005 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。桁数が揃っているので、文字列のまま大小を比べられる。
-- 適用方法は README.md の「配信の記録」を参照。

-- チャットで発言した人を1人1行で持つ（worker/viewer-store.ts の recordViewerMessage）。
--
-- 発言そのものは貯めない（チャットは件数の桁が違い、D1の書き込みの枠を食い合う）。貯めるのは人で、
-- 1人1行なので数千人でも数MBに収まり、消さずに持ち続けられる。
--
-- user_id を鍵にするのは、login と display_name は本人がいつでも変えられるため。名前で照合すると、
-- 改名した人が別人として増えてしまう。login と display_name は「最後に見た名前」として持つだけで、照合には使わない。
--
-- last_badges は発言の通知に含まれるバッジ（broadcaster・moderator・vip・subscriber など）をカンマ区切りで持つ。
-- サブスク・VIPの状態はTwitchが真実の持ち主なので、自前では管理せず、最後に観測した値を記録するだけにする。
--
-- last_message_id は、同じ通知が再送されたときに message_count を二重に増やさないための鍵である
-- （Twitchは応答が届かなかった通知を再送する）。
--
-- note は配信者が手で書くメモ。LLM が作る人物像は混ぜない（機械の推測と人が書いたものを区別するため）。
CREATE TABLE viewers (
  user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  last_badges TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- 一覧の並び順（最後に発言した順）と、日時での絞り込みに効かせるための索引
CREATE INDEX viewers_last_seen_at ON viewers (last_seen_at);

-- 名前での絞り込み（前方一致）に効かせるための索引。
-- 部分一致（LIKE '%...%'）にしないのは、索引が効かず全件走査になり、D1の rows read を食うためである。
CREATE INDEX viewers_login ON viewers (login);
