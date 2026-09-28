---
paths:
  - "worker/**"
---

# Worker（`worker/`）と失敗の記録

`worker/` は `/api/*` を処理するWorkerのコードで、ブラウザ用の `src/` からは読み込まない。経路の一覧は `worker/index.ts`。管理用API（`/api/admin/*`）は `requireAdmin`、オーバーレイ用APIは `requireOverlayKey` で守り、チャット用API（`/api/chat/*`）だけは守らずKVに1時間貯める。保存先はKV（`STORE`）・R2（`MEDIA`）・D1（`DB`。テーブルは `migrations/`、SQLは `stats-store.ts` に集め、必ずプレースホルダを使う）。`fetch`・現在時刻・KV・R2・D1は引数で受け取り、テストでは差し替える（`worker/fake-*.ts`）。HTTP APIの失敗は `{ error: { code, message } }` で返す（Fail-Fast）。cron の失敗は `collection_failures`（主キーは時刻と種類）に記録する。

外へ出る呼び出しには必ず時間制限をかける（`worker/timeout.ts` の `withTimeout`。中断の合図を受け取れない Workers AI のバインディングだけは `runWithTimeout`）。制限の値は相手ごとの定数を各モジュールが持ち（`twitch.ts` の `TWITCH_TIMEOUT_MS`・`gyazo.ts` の `GYAZO_TIMEOUT_MS`・`llm.ts` の `LLM_TIMEOUT_MS`）、クライアントを組み立てる関数の中で包む（呼び出し箇所ごとに包み忘れないため）。cron の収集（`collect.ts`）は1回ぶんの時間の予算（`COLLECT_BUDGET_MS`）を持ち、予算を過ぎたら配信の記録と古い記録の掃除は終えたうえで、材料づくり（OCRの取得・あらすじ・サイドスーパー・人物像）だけを次の収集へ回し、`collection_failures`（`collect-budget-exceeded`）に1行残す。→ `docs/decisions/worker.md`

利用者向けの説明は `docs/guide/deploy.md`（`/api/*` の一覧）と `docs/guide/stats.md`（配信の記録）。
