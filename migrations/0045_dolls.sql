-- 人形（視聴者が所持する人形。issue #418）
--
-- 日時は 0001〜0044 と同じく UTC の ISO 8601（例: 2026-10-21T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- 人形の組を1組1行で持つ（worker/doll-store.ts）。1組は「ふつうの人形」と「スーパー人形（ふつう3つ分の価値）」の2種類で、
-- それぞれ名前と画像（R2 の素材の ID）を持つ。配信ごとに組を選び直すので、組は配信をまたいで残す。
--
-- current は「いまの人形」の印で、1 か NULL だけを持つ。UNIQUE なので 1 を持てるのは1行だけになる
-- （SQLite の UNIQUE は NULL どうしを重なりとみなさない）。選び直すときは、外してから付ける（同じ文で付け替えると、
-- 行ごとに確かめる UNIQUE がその途中で失敗しうるため）。
-- id は台帳から指されるので AUTOINCREMENT にして、消した組の ID を次の組に使い回させない。
CREATE TABLE doll_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normal_name TEXT NOT NULL,
  normal_media_id TEXT NOT NULL,
  super_name TEXT NOT NULL,
  super_media_id TEXT NOT NULL,
  current INTEGER UNIQUE CHECK (current = 1),
  updated_at TEXT NOT NULL
);

-- 人形の増減を1件1行で持つ台帳（worker/doll-store.ts）。所持数は user_id・set_id・kind ごとの delta の合計で出す。
-- 増減の数だけ行が増えるが、人形の受け渡しは発言ほど頻繁ではないので量は小さい。何で増えて何で減ったかを後から追えるよう、
-- 所持数を1行に足し込まずに増減を残す。
--
-- user_id は Twitch のユーザー ID（viewers.user_id と同じ鍵）。viewers の行を指す外部キーにはしない
-- （チャットで発言していない人にもトリガーで渡せるようにするため。issue #419）。視聴者の記録を消すときは台帳も消す。
-- reason は何で増減したか（manual・trigger など）。種類は今後の段階で増えるので CHECK にせず、worker/doll.ts の一覧で確かめる。
-- source_id はきっかけの ID で、Twitch の通知の再送で二重に増減させないために UNIQUE にする（手での増減は毎回新しい ID を振る）。
-- session_id は記録した時点の配信（stream_sessions の開いた行）。配信外なら NULL のまま持つ。
CREATE TABLE doll_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  set_id INTEGER NOT NULL REFERENCES doll_sets (id),
  kind TEXT NOT NULL CHECK (kind IN ('normal', 'super')),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX doll_ledger_holder ON doll_ledger (user_id, set_id, kind);
CREATE INDEX doll_ledger_set ON doll_ledger (set_id);
