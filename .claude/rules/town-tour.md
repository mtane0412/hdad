---
paths:
  - "src/town-tour/**"
  - "scripts/town-tour/**"
  - "public/town-tour/**"
  - "worker/town-*.ts"
---

# 市町村紹介（レイドで流すランダムな市区町村の紹介）

引く対象の市町村の一覧（`src/town-tour/towns.json`）と日本地図（`public/town-tour/japan.topo.json`。各形の `properties.code` が一覧のコード）は、どちらも `scripts/town-tour/build-data.ts` が国土数値情報の N03 から作る生成物で、**手で直さない**。一覧と地図のコードの1対1は `src/town-tour/towns.test.ts` が検証する。

- 市町村の識別はコード（全国地方公共団体コードの5桁）で行う。名前は一意でない（北海道の泊村が2つある）ので、名前で探さない
- 政令市は市のコードで1件（市のコードは `DESIGNATED_CITY_CODES` の表）、東京23区は1区ずつ、北方領土の6村は入れ、所属未定地は外す
- 実行時に外部（geolonia など）へ一覧を取りに行かない。地図は Canvas 2D で描き、外部のタイルや MapLibre を持ち込まない
- 記事名の表（`src/town-tour/articles.json`。コード → 日本語版 Wikipedia の記事名）は `scripts/town-tour/build-articles.ts` が Wikidata の全国地方公共団体コード（P429。検査数字付きの6桁）から作る生成物で、**手で直さない**。同じコードの項目が複数ある市町村は `PREFERRED_ITEMS` の表で指名し、表に無ければエラーで止める。一覧との1対1は `towns.test.ts` が検証する
- 紹介は貯めずに、合成ページが `GET /api/overlay/town-tour?code=` を呼ぶたびに作る（`worker/town-tour-routes.ts`）。Twitch の Webhook の中では作らない（`waitUntil` の30秒に LLM の待ち時間が収まらない）
- 材料は記事の本文から見出しの名前で系統ごとに拾う（`worker/town-wikipedia.ts` の `pickTownMaterial`）。LLM には材料にある内容で固定の5項目（`worker/town-tour.ts` の `TOWN_TOUR_ITEMS`）を埋めさせるだけにし、材料に無い項目は空のまま返す。失敗は空の紹介で取り繕わず502にし、`collection_failures`（`town-tour-failed`）に残す
- 出典として記事の URL を紹介と一緒に返す（Wikipedia の本文は CC BY-SA）
- Worker は一覧と記事名の表を `src/town-tour/` から読む（Worker から `src/` を読み込む例外）

経緯は `docs/decisions/town-tour.md`、出典の表記と作り直しの手順は `docs/guide/town-tour.md`。
