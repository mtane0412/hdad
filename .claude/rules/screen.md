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

読み取った文字（OCR）を取りに行くのは **cron だけ**である（`worker/collect.ts` の `fetchScreenOcr`）。上げた直後は生成が終わっていないので、`postScreen` の中では取らない。取り先は `metadata.ocr.description`（トップレベルの `ocr` ではない）。空で返ったら記録せず数えるだけにして次の収集へ回し、`OCR_MAX_ATTEMPTS`（3回）で諦める。1枚で失敗したらその回の残りは取りに行かず、`collection_failures`（`screen-ocr-failed`）に残して収集は続ける。ただし404（画像が消えている）だけは、その1枚を諦めて（`abandonOcr`）先へ進む（撮った順に引くので、止めるとその1枚が先頭に居座り後ろへ永久にたどり着けない）。

読み取った文字は、そのままでは材料にしない。cron が**篩**（`worker/screen-ocr.ts`）に通し、残った行だけを `screen_lines` に積む（`worker/collect.ts` の `siftScreenOcr`）。篩は3段で、自前の文字の除去（サイドスーパー・視聴者の発言と表示名・字幕。`readOwnScreenTexts`）・中身のない行の除去（正規化して3文字未満、数字だけ）・既出の除去（その配信で既に渡した行に近いもの。初出は必ず残す）である。

**比べ方は完全一致ではなく、文字2連の重なり（Dice係数 0.7。`SCREEN_LINE_SIMILARITY`）である。** OCRは同じ画面でも毎回違う文字を返すので、完全一致では同じ画面を畳めない（実測で2枚目の削減率が15%に留まり、2連の重なりにすると99%になった）。**この判定方法を外すと、高頻度で撮る意味がなくなる。** 正規化（`normalizeScreenLine`）はNFKC・小文字化・空白除去・記号落としに留め、文字そのものは落とさない。

`worker/screen-ocr.ts` は**LLMもD1も触らない純粋な関数だけ**を持ち、材料（自前の文字・既出の行）は呼び出し側が読んで渡す。通し終えた1枚は `screen_captures.sifted_at` で印を付け、**残った行が0行でも印を付ける**（同じ画面を撮り続けるあいだ0行になるのが普通なので、行の有無では代用できない）。`screen_lines` の保持期間も `screen_captures` と同じ1日である。

利用者向けの説明は `docs/guide/screen.md`。
