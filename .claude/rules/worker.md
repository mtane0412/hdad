---
paths:
  - "worker/**"
---

# Worker（`worker/`）と失敗の記録

`worker/` は `/api/*` を処理するWorkerのコードで、ブラウザ用の `src/` からは読み込まない。経路の一覧は `worker/index.ts`。管理用API（`/api/admin/*`）は `requireAdmin`、オーバーレイ用APIは `requireOverlayKey` で守り、チャット用API（`/api/chat/*`）だけは守らずKVに1時間貯める。保存先はKV（`STORE`）・R2（`MEDIA`）・D1（`DB`。テーブルは `migrations/`、SQLは `stats-store.ts` に集め、必ずプレースホルダを使う）。`fetch`・現在時刻・KV・R2・D1は引数で受け取り、テストでは差し替える（`worker/fake-*.ts`）。失敗は `{ error: { code, message } }` で返す（Fail-Fast）。cron の失敗は `collection_failures`（主キーは時刻と種類）に記録する。→ `docs/decisions/worker.md`
