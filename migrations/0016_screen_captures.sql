-- 配信画面の取り込み（issue #122 Phase 1）
--
-- 日時は 0001〜0015 と同じく UTC の ISO 8601（例: 2026-09-28T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- 配信画面を撮った1枚の記録。OBSのブラウザソースに置いた裏方のページ（overlay/backstage/）が
-- obs-websocket で現在のプログラムシーンを撮り、Worker が Gyazo へ上げて、ここに1行を残す。
--
-- 画像そのものはここに持たない。Gyazo に上げた画像IDだけを持ち、その画像に作られるOCRのテキストを
-- あとから取りに行くための手がかりにする（issue #122 Phase 2）。配信画面に出ている文字を、
-- 配信者の発話（transcripts）と視聴者の発言（stream_chat_messages）に続く3つ目の材料にするために持つ。
--
-- session_id を持つのは、材料を「いま進んでいる配信のぶん」に限るためである。記録するときの結びつけ方は
-- transcripts・stream_events と同じで、配信中の区切りが無ければ1行も書かない（配信前の準備画面や
-- 配信後のデスクトップを貯めないため）。
--
-- image_id は Gyazo が振る画像IDである。主キーにするのは、同じ画面を撮ったときに Gyazo が同じ画像IDへ
-- 畳むため、同じ1枚で行が増えないようにするためである。
CREATE TABLE screen_captures (
  image_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

-- 材料の読み出し（配信ごとに、撮った順）に効かせるための索引
CREATE INDEX screen_captures_session ON screen_captures (session_id, captured_at);

-- 古い行の掃除（日時での絞り込み）に効かせるための索引
CREATE INDEX screen_captures_captured_at ON screen_captures (captured_at);
