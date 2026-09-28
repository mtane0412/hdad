---
paths:
  - "src/stats/**"
  - "worker/stats-*.ts"
---

# ダッシュボード（`/`）

ダッシュボード（`/`）はアプリのページ（`src/stats/stats-page.tsx`）。Workerが貯めた配信の記録（`/api/admin/stats/*`）を読み、期間（7・30・90日）の概要・フォロワー数の推移・配信の一覧を出す。配信を選ぶとその配信の視聴者数の推移を読み込んで一覧の中に出す。Workerの呼び出し（`src/stats/api.ts`）と集計・整形（`src/stats/summary.ts`）は画面から分けてテストする。グラフは shadcn の `chart`（Recharts）で、色は明暗のどちらでも読める `--chart-2` を使う。日時はブラウザのタイムゾーンで出し、記録が無い値は「—」と書いて0と区別する
