-- 配信の「これまでのあらすじ」（issue #65 Phase 8b）
--
-- 日時は 0001〜0009 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。
-- 適用方法は README.md の「配信の記録」を参照。

-- いま進んでいる配信のあらすじ。cron（worker/collect.ts）が5分おきに作り直し、
-- チャットのコマンド（応答文の差し込み語 {summary}）がそのまま読み出して返す。
--
-- 配信ごとに1行だけ持つ（session_id が主キー）。配信が変われば行も別になるので、
-- 前の配信のあらすじが次の配信に持ち越されることはない。
--
-- あらすじは毎回ゼロから作り直すのではなく、前回のあらすじに新しい材料を積み上げて書き直させる。
-- 長い配信でも1回あたりの入力が一定に保たれ、Workers AI の無料枠（Neurons）を食い潰さないためである
-- （viewers の summary を前回のものを踏まえて書き直すのと同じ考え方）。
--
-- そのため「どこまでを材料にしたか」を材料ごとに持つ。1組にまとめて両方の最大時刻を入れると、
-- 遅れているほうのテーブルの行が次回の読み出しから漏れる（文字起こしと発言は別々に届くため）。
--
-- 目印は日時だけでは足りず、メッセージIDと組で持つ。記録する時刻はWorkerが受け取った時刻なので、
-- 立て続けに届いた2件が同じ時刻になることがあり、そこで読み出しの件数の上限に当たると、残った同時刻の行が
-- 次からの「この日時より後」に一度も入らず永久に漏れる。読む順（日時・メッセージIDの順）と同じ組で比べる。
-- まだ一度も作っていない配信では、呼び出し側が空文字の組を渡して全件を読む（文字列比較では空文字が最小）。
CREATE TABLE stream_summaries (
  session_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  -- 最後に材料にした発話（transcripts）の spoken_at と message_id
  transcripts_until TEXT NOT NULL,
  transcripts_until_id TEXT NOT NULL,
  -- 最後に材料にした発言（stream_chat_messages）の sent_at と message_id
  chat_until TEXT NOT NULL,
  chat_until_id TEXT NOT NULL,
  -- このあらすじを作った日時。コマンドの応答に「いつ時点か」を添えられるようにするために持つ
  updated_at TEXT NOT NULL
);

-- あらすじの材料の読み出し（配信ごとに、発言の順）に効かせるための索引。
-- 0008 で作った stream_chat_messages_user は人ごとのまとまりに効くもので、配信ごとには効かない。
CREATE INDEX stream_chat_messages_session ON stream_chat_messages (session_id, sent_at);
