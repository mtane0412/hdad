-- 配信中の文字起こし（issue #64 Phase 8a）
--
-- 日時は 0001〜0008 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。
-- 適用方法は README.md の「配信の記録」を参照。

-- 配信者が喋った内容。ゆかりねっとコネクターNEO（ゆかコネNEO）の音声認識の結果を、
-- OBSのブラウザソースに置いた中継ページ（transcript/index.html）が押し込んでくる。
--
-- 「途中から来た人向けのあらすじ」（issue #65）の材料にするために持つ。チャットの本文と同じく、
-- 貯めるのは配信中のぶんだけで、配信が終わってしばらくしたら cron が消す（worker/collect.ts）。
-- 翻訳（ゆかコネNEO の Text2〜Text6）は保存しない。あらすじには母国語だけあればよい。
--
-- session_id を持つのは、あらすじを「いま進んでいる配信のぶん」に限って作るためである。記録するときの
-- 結びつけ方は stream_events・stream_chat_messages と同じで、配信中の区切りが無ければ1行も書かない
-- （テスト配信の前や配信外の独り言を貯めないため）。
--
-- message_id はゆかコネNEO が振る MsgID である。主キーにするのは、同じ発話が二度届いても行が増えないように
-- するためである（ゆかコネNEO は確定したあとの1件も、表示の残り時間を減らしながら繰り返し押し出してくる）。
CREATE TABLE transcripts (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  spoken_at TEXT NOT NULL,
  text TEXT NOT NULL
);

-- あらすじの材料の読み出し（配信ごとに、喋った順）に効かせるための索引
CREATE INDEX transcripts_session ON transcripts (session_id, spoken_at);

-- 古い行の掃除（日時での絞り込み）に効かせるための索引
CREATE INDEX transcripts_spoken_at ON transcripts (spoken_at);
