---
paths:
  - "worker/stream-chapter*.ts"
  - "worker/collect.ts"
  - "worker/stream-chat-store.ts"
  - "worker/stats-store.ts"
  - "src/stats/**"
  - "migrations/*chapter*.sql"
---

# 配信で何が話されたか（章）

配信を約30分ごとの区間（`CHAPTER_WINDOW_MS`）に分け、区間ごとに LLM がまとめた見出しと要約を1章として `stream_chapters`（`migrations/0022_stream_chapters.sql`）に残す。材料は区間の中の発話（`transcripts`）・発言（`stream_chat_messages`）・画面の文字（`screen_lines`。積んだ時刻 `sifted_at` で振り分ける）で、材料が消えたあとも章は消さない。作るのは cron（`worker/collect.ts` の `makeStreamChapter`）で、配信中に区間が閉じて `CHAPTER_SETTLE_MS` 待ったあと、1回の収集で1章までにする。どこまで章にしたかは `stream_sessions.chaptered_until` に持ち、発話の無い区間は章を作らずにこの目印だけを進める。区間の決め方（`nextChapterWindow`）と件数の上限での切り方（`fitChapterMaterial`）は `worker/stream-chapter.ts` の純粋な関数で、上限を超えた区間は短く切って残りを次の章に回す（上限で読むのをやめるだけにしない）。上限を超えた行がすべて区間の始まりと同じ時刻で切れないときは、その時刻の行だけを丸ごと1つの区間にする（`sameTimeWindow`・`readChapterLinesAt`。投げると区間が進まなくなる）。LLMは箇所を増やさず `streamSummary` を指名する。失敗は `stream-chapter-failed` として記録し、区間を進めないが、その回のうちにほかの配信の章づくりへは進む。人物像づくりは、終わりまで章にし終えた配信の発言だけを材料にする（`worker/stream-chat-store.ts` の `CHAPTERED_SESSIONS`）。ダッシュボードの配信の詳細（`/api/admin/stats/sessions/:id` の `chapters`・`summary`）で読み返す。→ `docs/decisions/stream-chapters.md`

利用者向けの説明は `docs/guide/stats.md` の「配信で何が話されたか（章）」。
