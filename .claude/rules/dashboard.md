---
paths:
  - "src/stats/**"
  - "worker/stats-*.ts"
---

# ダッシュボード（`/`）

ダッシュボード（`/`）はアプリのページ（`src/stats/stats-page.tsx`）。Workerが貯めた配信の記録（`/api/admin/stats/*`）を読み、期間（7・30・90日）の概要・フォロワー数の推移・配信の一覧を出す。配信を選ぶとその配信の視聴者数の推移と、何が話されたか（章とあらすじ。`.claude/rules/stream-chapters.md`）・章ごとの配信タイトルの候補（`.claude/rules/stream-title.md`）を読み込んで一覧の中に出す。候補を作るかのスイッチもこのページに置き、切り替えたらすぐ保存する。Workerの呼び出し（`src/stats/api.ts`）と集計・整形（`src/stats/summary.ts`）は画面から分けてテストする。グラフは shadcn の `chart`（Recharts）で、色は明暗のどちらでも読める `--chart-2` を使う。Recharts を読み込むのはグラフのファイル（`src/stats/time-chart.tsx`・`src/llm/usage-chart.tsx`）だけで、ページは `React.lazy` で切り離して読み込む（ほかのページを開くときに Recharts を運ばないため）。配信の詳細には、その配信の時間に開いた意見ボードのテーマの振り返りも出す（`src/stats/session-opinions.tsx`。`.claude/rules/opinions.md`）。受けたレイドは、通知の受け口（`worker/webhook-routes.ts`。読み取りはトリガーと同じ `extract`）が `recordRaid` で `stream_events` の行と `raid_details`（`migrations/0037_raid_details.sql`）を1つの batch で書き、配信の詳細（`raids`）にレイドごとのレイド元・人数を出す。レイドの後の定着（直前・30分後・60分後の視聴者数）は `src/stats/summary.ts` の `raidRetention` だけが `viewer_samples` から求め、配信が先に終わった・その時刻の近くに記録が無いときは値を作らず理由（配信終了・まだ・記録なし）を持つ。日時はブラウザのタイムゾーンで出し、記録が無い値は「—」と書いて0と区別する。

利用者向けの説明は `docs/guide/stats.md`。→ `docs/decisions/dashboard.md`
