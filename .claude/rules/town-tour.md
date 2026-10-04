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
- 流すきっかけはトリガーの動作 `townTour`（レイドとキーワードの行だけ。`worker/alert-config.ts` の `TOWN_TOUR_KINDS`）と、トリガー画面の試し再生（`POST /api/admin/town-tour/demo`）。どちらも Worker は市町村を引いて冒頭の一文と音の設定を添え（`worker/town-tour-call.ts`）、`AlertChannel` の目印 `townTour` の接続へ押し出すだけにする
- 合成ページの素材の種類は `townTour`（`src/overlay/stage.ts` の `mountTownTour`）。アラートの列には入れず、素材の中で届いた順に1件ずつ流す。場面は再生を始めた時刻・紹介が届いた時刻と現在時刻だけから決める（`src/town-tour/timeline.ts` の `sceneAt`）。地図の読み解きは `topo.ts`、映す範囲は `camera.ts`、描画は `view.ts` で、描画だけがテストを持たない
- 紹介を作れなかった1件はすぐに終え、失敗を素材の箱に出して次へ進む。出典（記事名と CC BY-SA 4.0）は紹介を流すあいだ画面に出し続ける
- 演出で鳴らす音の枠は `src/town-tour/sound.ts` の `TOWN_TOUR_SOUND_SLOTS` で固定し（Worker もここから読む例外）、配信者は枠ごとにアップロード済みの音声を選ぶか「鳴らさない」にするだけにする。設定は市町村紹介として1つ（`worker/town-tour-sound.ts`。KV の `town-tour-sound`）で、画面はトリガーのページの「市町村紹介」のカード（`src/admin/town-tour-sound-card.tsx`）。押し出しの中身に音声の URL にして載せる（`playbackSoundOf`）。音声ファイルはリポジトリに入れない（配布元が再配布を禁じている）
- 合成ページで鳴らす時刻は `src/town-tour/sound-cues.ts` の表（`soundCuesOf`）だけが決め、秒数は `timeline.ts` の定数と `tourSpanOf` から取る（場面とずらさない）。鳴らしたことの記録（`SoundCue.id`）と止める判断（再生の終わり・紹介の失敗）は `mountTownTour`、Audio 要素の操作は `sound-player.ts` が受け持ち、後者だけがテストを持たない。刻むのは描画のループではなくタイマーにする。再生を始められなかった音は素材の箱に失敗を出す

経緯は `docs/decisions/town-tour.md`、出典の表記と作り直しの手順は `docs/guide/town-tour.md`。
