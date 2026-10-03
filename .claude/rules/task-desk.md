---
paths:
  - "src/task-desk/**"
  - "worker/task-desk*.ts"
  - "worker/webhook-routes.ts"
  - "worker/bot-config.ts"
  - "worker/alert-channel.ts"
  - "migrations/*task_declarations*.sql"
---

# 作業机（素材の種類 `taskDesk`）

作業机は、視聴者がチャットの組み込みのコマンド `!task <作業>`・`!done` で宣言した作業を1人1行で並べる合成ページの素材（素材の種類 `taskDesk`）。コマンドの読み取りと受け付けない理由の文言は `worker/task-desk.ts` だけが持ち（作業は `MAX_TASK_LENGTH` 文字を超えたら切り詰めずに拒む）、読み書きは `worker/task-desk-store.ts`、実行（書く・押し出す・bot が理由を返す）は `worker/task-desk-command.ts` が持つ。LLM は呼ばない。

チャットの受け口（`worker/webhook-routes.ts` の `replyToChatMessage`）は、自動モデレーションとトリガーの判定のあと、登録したコマンドより先に `handleTaskDeskCommand` を呼ぶ。bot が無くても宣言は残す（理由だけは返せない）。組み込みの名前（`BUILT_IN_COMMAND_NAMES`）は `worker/bot-config.ts` が登録させない。モデレーションの削除の通知（`FEED_ONLY_EVENT_TYPES` のうち削除系）は、自分のチャンネルのものだけ `applyModerationToTaskDesk` に渡し、当たる宣言を消して押し出し直す。

宣言は `task_declarations`（`migrations/0024_task_declarations.sql`）に配信 × 視聴者で1人1行持つ。宣言・完了・作業机の表示・モデレーションでの削除は配信中の配信の行だけを対象にし（配信中の区切りは `INSERT ... SELECT` などの文の中で引く）、終わった配信の行は消さずに残す。同じ発言の再送では宣言した時刻も完了も変えず、もう完了している行に `!done` が届いても何もしない。処理済みの `!done` の再送で新しい宣言を完了にしないよう、完了と鍵（`<発言ID>:taskDone` を `replied_chat_messages` へ）の記録は1つの `batch` で行う。作業の文字数は書記素クラスタ（`Intl.Segmenter`）で数える。押し出しは `AlertChannel` の目印 `taskDesk`（`pushTaskDesk`・`connectTaskDeskSocket`）に相乗りし、作業机を丸ごと（`TaskDeskSnapshot`）送る。押し出しと返信の失敗は投げずに `task-desk-push-failed`・`chat-reply-failed` として記録する。

合成ページ（`src/overlay/stage.ts` の `mountTaskDesk`）は、開いたとき・つながるたび・5分おきに `GET /api/overlay/task-desk`（`worker/task-desk-routes.ts`）で読み直し、押し出しが届いたら置き換える（読んでいるあいだに押し出しが届いたら読んだ結果は捨てる）。並びと人数の上限（`TASK_DESK_LIMIT`。未完了が上）は Worker の `readTaskDesk` だけが決める。祝うかどうかは `src/task-desk/entry.ts` の `justCompleted` だけが決める。1行の形は `worker/task-desk.ts` の `TaskDeskEntry` と `src/task-desk/entry.ts` で合わせる。

みんなの作業時間（issue #209）の計算は `worker/task-desk-worktime.ts` の `sumWorkTime` だけが持つ（宣言から完了まで。未完了はいままで、終わった配信は `ended_at` で打ち切る）。打ち直す前の宣言の時間は `declareTask` が `prior_work_ms`（`migrations/0025_task_declarations_prior_work.sql`）へ足し込む（同じ発言の再送では足さない）。合計は書き込まず、読むたびに宣言の行から数える（作業机の `readTaskDeskSnapshot`・ダッシュボードの `getSession`・`{worktime}` の `readCurrentWorkTime`）。誰も宣言しなかった配信は null（ダッシュボードは「—」、作業机は合計の行を隠す）。作業机へは読んだ時刻と作業中の人数を添えて送り、合成ページが毎フレーム経過時間ぶん進める（`src/task-desk/entry.ts` の `workTimeText`）。`{worktime}` はチャットコマンドの応答文だけで使える。→ `docs/decisions/task-desk.md`

利用者向けの説明は `docs/guide/task-desk.md`。
