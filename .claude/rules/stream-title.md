---
paths:
  - "worker/stream-title*.ts"
  - "worker/collect.ts"
  - "src/stats/**"
  - "migrations/*title*.sql"
---

# 配信タイトルの候補（試験運用。issue #268）

配信の流れに合わせて配信タイトルを変えられるかを確かめる段階0で、**Twitch のタイトルには何も書き込まない**（`PATCH /helix/channels`・`channel:manage:broadcast` は段階1まで入れない）。cron（`worker/collect.ts` の `proposeStreamTitle`）が章立てのあとに、配信中の配信の**最後の章にまだ候補が無いときだけ**1つ作り、Jev（`judgeStreamTitleCandidate`。用途 `streamTitle` の Noul）に「配信タイトルとして公開してよいか」を尋ねて、確率をしきい値と比べずに候補と一緒に `stream_title_candidates`（`migrations/0028_stream_title_candidates.sql`。主キーは章と同じ組）へ残す。動くのは設定（`worker/stream-title-config.ts`。KVは `stream-title-settings`、既定はオフ）を入れたときだけで、ダッシュボードのスイッチ（`/api/admin/stream-title/settings`）で切り替える。

候補は配信者の固定部分のあとに続く一言で、書かせるのは「何を話したか」ではなく「何をしているか」。材料は最後の章・あらすじ・その章の区間の画面の文字・いまのタイトルとカテゴリで、**視聴者の発言は材料に入れない**（`worker/stream-title.ts` の `buildStreamTitlePrompt`）。1行でない・`MAX_STREAM_TITLE_CANDIDATE_LENGTH`（20字）を超える候補は切り詰めずに捨てる。失敗（LLM・形・Jev）は `stream-title-failed` として記録し、次の収集でやり直すが、次の章ができたら前の章には戻らない。ダッシュボードの配信の詳細（`titleCandidates`）で、候補を章の下に「タイトルの候補（機械）」として出す（方針11）。→ `docs/decisions/stream-title.md`

利用者向けの説明は `docs/guide/stats.md` の「配信タイトルの候補（試験運用）」。
