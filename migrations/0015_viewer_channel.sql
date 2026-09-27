-- 視聴者自身のチャンネルの内容を、最後に観測した値として持つ3列（issue #98）
--
-- 日時は 0001〜0014 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。
-- 適用方法は README.md の「配信の記録」を参照。
--
-- 視聴者が自分でも配信している人であれば、そのチャンネルからさらに詳しい情報が取れる。その内容を
-- チャットの文面づくり（worker/ai-chat.ts）と人物像づくり（worker/viewer-summary.ts）の材料にする。
--
-- 「配信者かどうか」という真偽値では持たない。理由は3つある。
-- 1. last_badges に入る broadcaster は「このチャンネルの配信者本人」を指すため、is_broadcaster のような列を
--    足すと、同じ行の中で broadcaster が2つの意味を持ち、読む人が取り違える。
-- 2. Twitchは「配信者かどうか」を返さない。GET /helix/users の broadcaster_type は partner / affiliate / 空文字で
--    収益化の区分であり、アフィリエイト未満の配信者は空文字になる（偽陰性が多い）。GET /helix/channels は
--    誰に対しても行を返し、一度も配信していない人では game_name と title が空文字になるだけである。
--    つまりこれは真偽ではなく程度であり、真偽値で保存すると「どこから配信者とみなすか」という丸め方が
--    保存の時点で固定され、あとから変えても過去の行は直らない。
-- 3. サブスク・VIPを自前で管理しない方針（migrations/0006_viewers.sql）と同じで、Twitch側で変わる状態を
--    自前の真偽値で持つと必ず食い違う。「配信を始めた視聴者」はまさにこれに当たる。
--
-- 「配信者らしい」という判断は保存側では行わず、使う側（プロンプトと画面）が持つ。

-- 最後に観測した、その人のチャンネルのカテゴリ（GET /helix/channels の game_name）。
-- 一度も配信していない人では空文字になる（Twitchが空文字を返す）。
ALTER TABLE viewers ADD COLUMN last_stream_game TEXT NOT NULL DEFAULT '';

-- 最後に観測した、その人のチャンネルのタイトル（GET /helix/channels の title）。カテゴリと同じく空文字になりうる。
ALTER TABLE viewers ADD COLUMN last_stream_title TEXT NOT NULL DEFAULT '';

-- そのチャンネルを観測した日時。まだ調べていない人（この列を足す前からある行を含む）では NULL。
--
-- この列があるおかげで、「調べたが配信歴が無い」（この列が入っていて last_stream_game が空文字）と
-- 「まだ調べていない」（この列が NULL）を区別できる。真偽値1列ではこの2つが同じ false に潰れ、
-- 画面でも材料でも「配信していない人」と「未調査の人」を見分けられない。
ALTER TABLE viewers ADD COLUMN channel_checked_at TEXT;
