---
paths:
  - "src/work-log/**"
  - "worker/work-log*.ts"
  - "worker/github-routes.ts"
  - "worker/collect.ts"
  - "worker/alert-channel.ts"
  - "migrations/*dev_events*.sql"
---

# 作業ログ（素材の種類 `workLog`）

作業ログは、その配信の開発の出来事（コミットの push・PR のマージ）と章の見出しを時刻つきで新しい順に並べる合成ページの素材（素材の種類 `workLog`）。1行は `worker/work-log.ts` の `WorkLogEntry`（`src/work-log/entry.ts` と合わせる）で、機械（LLM）が作った章（`chapter`）と実際に起きた出来事（`commit`・`merge`）は種類の印と見た目の両方で見分けて出す（方針11。`src/work-log/view.ts`・`work-log.css`）。

開発の出来事は、GitHub の受け口（`worker/github-routes.ts`）がトリガーの動作のあとに、トリガーの設定と関係なく `dev_events`（`migrations/0023_dev_events.sql`。主キーは `github:<X-GitHub-Delivery>`）に残して押し出す。1行の中身は `extract` の結果から `devEventOf` が作る（通知を2か所で読み解かない）。配信外に届いたものは残さない。章は cron（`worker/collect.ts` の `makeStreamChapter`）が配信中の配信の章を作ったときだけ押し出し、押し出しの失敗は `work-log-push-failed` として記録して章は残す。押し出しは `AlertChannel` の目印 `workLog`（`pushWorkLogEntry`・`connectWorkLogSocket`）に相乗りし、新しい Durable Object は足さない。

合成ページ（`src/overlay/stage.ts` の `mountWorkLog`）は、開いたとき・つながるたび・5分おきに `GET /api/overlay/work-log`（`worker/work-log-routes.ts`）で読み直して一覧を置き換え、押し出された1行は `mergeEntries` で id ごとに重ねる。件数は Worker も合成ページも `WORK_LOG_LIMIT`（20）で古いものから落とし、何行映すかは素材の枠の大きさで決める。→ `docs/decisions/work-log.md`

利用者向けの説明は `docs/guide/work-log.md`。
