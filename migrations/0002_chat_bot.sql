-- チャットボットの状態（issue #37）
--
-- 日時は 0001 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。桁数が揃っているので、文字列のまま大小を比べられる。
-- どちらのテーブルも「コマンドに一致した発言」のときだけ書く。チャットの全件は書かない
-- （チャットは件数の桁が違い、D1の書き込みの枠を配信の記録と食い合うため）。
-- 適用方法は README.md の「配信の記録」を参照。

-- 応答済みのチャット。Twitchが同じ通知を再送しても二度応答しないための鍵。
-- 増え続けないよう、書き込みのたびに古い行を消す（再送は短時間に起きるので、長く持つ必要がない）
CREATE TABLE replied_chat_messages (
  message_id TEXT PRIMARY KEY,
  replied_at TEXT NOT NULL
) WITHOUT ROWID;

-- コマンドを最後に使った時刻。クールダウン（同じコマンドに続けて応答しない秒数）の判定に使う。
-- 1コマンドにつき1行で、コマンドを消しても行は残るが、使われなければ増えない
CREATE TABLE command_uses (
  command_name TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
) WITHOUT ROWID;
