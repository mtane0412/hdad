---
paths:
  - "src/screen/**"
  - "worker/screen-*.ts"
  - "worker/gyazo.ts"
---

# 配信画面の取り込み（`/screen/`）

配信画面の取り込み（`/screen/`）はアプリのページ（`src/screen/screen-page.tsx`。つなぎ先と撮る間隔の設定だけ）だが、撮るのは裏方のページ（`overlay/backstage/`）に載せた裏方（`src/screen/task.ts`）である。同じPCで動くOBSの obs-websocket（既定 `ws://localhost:4455`。`host` は `localhost` か `127.0.0.1` だけ）につなぎ、**現在のプログラムシーン1枚**（`GetCurrentProgramScene` → `GetSourceScreenshot`。幅1280のPNG）を設定の間隔で撮って、オーバーレイ用キーで `POST /api/overlay/screen` へ画像そのものを送る。ソース名の設定は持たない（配信者が入力するのはポート・パスワード・間隔だけ）。

認証は obs-websocket のチャレンジ応答（SHA256を2段、どちらもBase64。`src/screen/protocol.ts`。WebCryptoで足りるのでライブラリは入れない）で、パスワードは Worker の設定（KVの `screen-settings`。`worker/screen-config.ts`）が持つ。つなぎ直しは持たず、切れていたら次の撮影のときにつなぎ直す。

**上げ先のコレクション（`collectionId`）は裏方のページに渡さない**（`GET /api/overlay/screen` が返すのは撮るのに要る4つだけ）。上げるのは Worker なので、上げ先を決めるのも Worker である。

Worker は配信中でなければ **Gyazo へ上げない**（配信前の準備画面を外へ出さないため）。上げるのは `worker/gyazo.ts`（`access_policy=only_me`・`metadata_is_public=false`・`fetch` は注入。コレクションの指定があるときだけ `collection_id` を添える）で、保存は `worker/screen-store.ts`（`screen_captures`。画像IDだけを持ち、画像は持たない）。Gyazo のアクセストークン（`GYAZO_ACCESS_TOKEN`）が無いときは黙って捨てず失敗させる。→ `docs/decisions/screen.md`

読み取った文字（OCR）を取りに行くのは **cron だけ**である（`worker/collect.ts` の `fetchScreenOcr`）。上げた直後は生成が終わっていないので、`postScreen` の中では取らない。取り先は `metadata.ocr.description`（トップレベルの `ocr` ではない）。空で返ったら記録せず数えるだけにして次の収集へ回し、`OCR_MAX_ATTEMPTS`（3回）で諦める。1枚で失敗したらその回の残りは取りに行かず、`collection_failures`（`screen-ocr-failed`）に残して収集は続ける。

利用者向けの説明は `docs/guide/screen.md`。
