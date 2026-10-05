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
- 人口と面積の表（`src/town-tour/stats.json`。コード → 住民基本台帳の人口と面積調の面積）は `scripts/town-tour/build-stats.ts` が作る生成物で、**手で直さない**。突き合わせはコードで行い、名前の揺れは `POPULATION_NAME_VARIANTS` の表で指名する。北方領土の6村の人口は null のまま持つ。一覧との1対1は `towns.test.ts` が検証する
- 人口と面積は LLM に作らせない。Worker は押し出しの中身に人口・面積・いま見ている人数（レイドは最後に記録した同接＋レイドの人数、キーワードと試し再生は最後に記録した同接で、配信中でなければ null。`worker/stats-store.ts` の `latestViewerCount`）の数だけを載せ（`townTourCallOf`）、文は合成ページの `src/town-tour/scale.ts` の `scaleLinesOf` だけが組み立てる。人数は割合で比べず「ひとり何人倒せば制圧」の形にする（少ない人数でも小ささを目立たせないため）
- 紹介は貯めずに、合成ページが `GET /api/overlay/town-tour?code=` を呼ぶたびに作る（`worker/town-tour-routes.ts`）。Twitch の Webhook の中では作らない（`waitUntil` の30秒に LLM の待ち時間が収まらない）
- 材料は記事の本文から見出しの名前で系統ごとに拾う（`worker/town-wikipedia.ts` の `pickTownMaterial`）。LLM には材料にある内容だけで、大見出し（`hook`）・それを支える1〜3項目（`points`。最後がオチ）・配信者への振り（`cue`）を作らせる（`worker/town-tour.ts` の `TownTour`）。材料が薄ければ大見出しは空にさせ、合成ページは大見出しの場面を飛ばす（これは失敗ではなく決めた形）。項目が無い・振りが空・長すぎる応答は補わず、問題と前回の応答を伝えて1回だけ作り直させ（`generateTownTour`）、それでも合わなければ投げる。失敗は空の紹介で取り繕わず502にし、`collection_failures`（`town-tour-failed`）に残す
- 出典として記事の URL を紹介と一緒に返す（Wikipedia の本文は CC BY-SA）
- 記事の代表画像（PageImages。本文と同じ問い合わせでファイル名を受け取る）は、`worker/town-image.ts` の `fetchTownImage` が作者とライセンスと画面に出す大きさの URL を取り、紹介と一緒に `image` として返す。地図・町章（SVG とファイル名の型 `isShowableImageFile`）・ライセンスが CC でも PD でもない・取れない・作者の表記が要るのに無い・長すぎる画像は `null` にし（失敗ではなく決めた形）、合成ページは画像の場面を飛ばす。別の画像で埋めない。問い合わせの失敗は `null` にせず投げる（紹介ごと502）
- Worker は一覧と記事名の表と人口・面積の表を `src/town-tour/` から読む（Worker から `src/` を読み込む例外）
- 流すきっかけはトリガーの動作 `townTour`（レイドとキーワードの行だけ。`worker/alert-config.ts` の `TOWN_TOUR_KINDS`）と、トリガー画面の試し再生（`POST /api/admin/town-tour/demo`）。どちらも Worker は市町村を引いて冒頭の一文・クイズの出題の識別子と都道府県を伏せた一文・音の設定を添え（`worker/town-tour-call.ts`）、`AlertChannel` の目印 `townTour` の接続へ押し出すだけにする
- 冒頭の都道府県当てクイズ（どのきっかけでも出す）の長さとヒントの間隔、回答の読み取り（`answeredPrefectureOf`）、ヒントの文は `src/town-tour/quiz.ts` だけが持つ（Worker もここから読む例外）。ヒントの材料（海に面しているか・隣り合う市町村）は合成ページが地図の形から求める（`topo.ts` の `decodeTownBorders`。分け合わない弧のうち外周と同じ向きの輪だけを海岸とし、県境の未定地や湖を海と取り違えない）
- 出題を開くのは合成ページで、クイズを流しはじめたときに `POST /api/overlay/town-tour/quiz` を呼ぶ（Worker が押し出した時点では開かない）。正解の都道府県は Worker が一覧のコードから引く。出題と最初の正解者は D1 の `town_tour_quizzes`（`worker/town-tour-quiz.ts`）に持ち、正解者は1つの文（RETURNING）で決める。判定は Webhook がチャットの発言を受けたとき、都道府県が1つだけ書かれた発言でだけ D1 を読む。最初の正解者は `pushTownTourAnswer` で同じ `townTour` の接続へ `type: 'answer'` を付けて押し出す（呼び出しは type を持たない）。AlertChannel に判定を持たせない。照らす処理の失敗は投げずに `town-tour-quiz-failed` として記録し、チャットのほかの処理を続ける
- 合成ページは正解者が届いた時刻（合成ページの時計）をクイズを終えた時刻にし、地図の演出・音の時刻・配信のBGMを下げる長さをそこから数える（`timeline.ts` の `quizEndOf`）。クイズの長さを過ぎて届いた正解者は出さない。出題を開けなかったら、その時刻でクイズを打ち切る（`QuizState.unopenedAt`）
- 紹介した市町村の記録（全国制覇マップ）は D1 の `town_tour_visits`（`worker/town-tour-visits.ts`。1市町村1行で、最初の記録を残す）に持つ。Worker は市町村を引くときに記録を読み、紹介済みを除いて引き（`pickTown`。すべて紹介済みなら全体から）、これまでの記録（`visited`）と流しきったら記録するきっかけと相手（`visit`。試し再生は null）を呼び出しに載せる。記録するのは合成ページで、振りまで流しきった時刻（`timeline.ts` の `visitRecordAtOf`）に `POST /api/overlay/town-tour/visit` を呼ぶ（プレビューと試し再生では呼ばない）。記録の失敗は `town-tour-visit-failed` として残して502にし、合成ページは箱に出すだけで制覇マップを止めない（方針5の例外）
- 制覇数と節目の一文（初めての都道府県・離島・都道府県の全制覇・10件ごと）は `src/town-tour/conquest.ts` の `conquestOf` だけが決め、合成ページは流しはじめるときに呼び出しの記録と自分が記録させた市町村を合わせて求めておく（`Playback.conquest`）。都道府県はコードの上2桁、全体の数と離島（隣り合う市町村が無い）は地図の境界（`decodeTownBorders`）から求める
- 締めの名誉町民の認定証（レイドと試し再生だけ）の相手は Worker が決めて呼び出しの `honoraryCitizen` に載せ（レイドはレイド元、試し再生は見本の名前、キーワードは null。`townTourCallOf`）、文面は合成ページの `src/town-tour/certificate.ts` の `certificateOf` だけが組み立てる（LLM に作らせない。自治体の名義や町章は使わず、発行者はこの配信。日付は再生を始めた時刻の日本時間の和暦）。`visit` から推し量らない（記録するかどうかとは別の判断）
- 合成ページの素材の種類は `townTour`（`src/overlay/stage.ts` の `mountTownTour`）。アラートの列には入れず、素材の中で届いた順に1件ずつ流す。場面は再生を始めた時刻・紹介が届いた時刻と現在時刻だけから決める（`src/town-tour/timeline.ts` の `sceneAt`）。場面の並び（クイズ → 正解 → 日本地図からズーム → 代表画像 → 大見出し → 項目 → 振り → 全国制覇マップ → 認定証。紹介の場面の並びは `tour.ts` の `tourLinesOf`）、場面ごとの長さは `timeline.ts` の定数（`IMAGE_MS`・`HOOK_MS`・`POINT_MS`・`PUNCHLINE_MS`・`CUE_MS`・`CONQUEST_MS`・`CERTIFICATE_MS`）と `tourSpanOf` が決める。地図の読み解きは `topo.ts`、映す範囲は `camera.ts`、描画は `view.ts` で、描画だけがテストを持たない
- 紹介を作れなかった1件はすぐに終え、失敗を素材の箱に出して次へ進む。出典（記事名と CC BY-SA 4.0）は紹介を流すあいだ画面に出し続ける。代表画像の作者とライセンスは、画像を出すあいだ出典の上の行に出す
- 代表画像は紹介が届いてから合成ページが読み込み（`image-loader.ts`。テストを持たない）、読み込み終えてから紹介を届いたものとして流す。読み込めなければ素材の箱に失敗を出し、画像を外した紹介として流す
- 演出で鳴らす音の枠は `src/town-tour/sound.ts` の `TOWN_TOUR_SOUND_SLOTS` で固定し（Worker もここから読む例外）、配信者は枠ごとにアップロード済みの音声を選ぶか「鳴らさない」にするだけにする。設定は市町村紹介として1つ（`worker/town-tour-sound.ts`。KV の `town-tour-sound`）で、画面はトリガーのページの「市町村紹介」のカード（`src/admin/town-tour-sound-card.tsx`）。押し出しの中身に音声の URL にして載せる（`playbackSoundOf`）。音声ファイルはリポジトリに入れない（配布元が再配布を禁じている）
- 合成ページで鳴らす時刻は `src/town-tour/sound-cues.ts` の表（`soundCuesOf`）だけが決め（「項目ごと」は大見出しと各項目、「締め」は振りの出だし）、秒数は `timeline.ts` の定数と `tourSpanOf` から取る（場面とずらさない）。鳴らしたことの記録（`SoundCue.id`）と止める判断（再生の終わり・紹介の失敗）は `mountTownTour`、Audio 要素の操作は `sound-player.ts` が受け持ち、後者だけがテストを持たない。刻むのは描画のループではなくタイマーにする。再生を始められなかった音は素材の箱に失敗を出す

- 紹介の BGM を鳴らした再生では、配信の BGM を下げておく長さ（`src/town-tour/bgm-duck.ts` の `bgmDuckHoldOf`）を、鳴らしはじめた・紹介が届いた・紹介を作れなかったときに `POST /api/overlay/bgm/duck` へ送る。「戻す」は送らず長さで送り、戻すのは裏方のページに任せる（合成ページが閉じられても下がったまま残さない）。BGM の枠が空なら送らず、プレビューでも送らない。送れなくても紹介は止めない
- ナレーション（冒頭の一文・大見出し・各項目・振りの読み上げ）の設定（読み上げるか・話者・速度）は、チャットの読み上げと別に市町村紹介として1つ持つ（`worker/town-tour-narration.ts`。KV の `town-tour-narration`。既定は読み上げない）。画面は「市町村紹介」のカードの区画（`src/admin/town-tour-narration-section.tsx`）で、音とは別に保存する。Worker は呼び出しに読み上げるかだけを載せ（`narration`）、話者と速度は合成の経路 `POST /api/overlay/town-tour/narration` が保存済みの設定から取る（読み上げない設定なら409。さくらは `createSakuraTts` で呼ぶ）。何を読むかと文の長さの上限は `src/town-tour/narration.ts` だけが持つ（Worker もここから読む例外）
- 合成ページは紹介が届いたら全部の文を並べて合成させ、音声の長さを読み終えてから（`narration-loader.ts`。テストを持たない）紹介を届いたものとして流す（`ReadyIntro.narration`）。場面は「読み上げの長さ＋余白」まで延ばし（決まった長さを下限にする）、冒頭の一文は着地で読み終えるまで大見出しへ進まない（`tourSpanOf`）。読み上げと、読んでいるあいだ紹介の BGM を下げて戻す時刻は音の表（`soundCuesOf`）に載せる。合成・読み込みに失敗した文は素材の箱に失敗を出し、その場面だけ文字を決まった長さで流す（紹介は止めない）。音声の URL は再生を終えたら手放す

経緯は `docs/decisions/town-tour.md`、出典の表記と作り直しの手順は `docs/guide/town-tour.md`。
