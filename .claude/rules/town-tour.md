---
paths:
  - "src/town-tour/**"
  - "scripts/town-tour/**"
  - "public/town-tour/**"
---

# 市町村紹介（レイドで流すランダムな市区町村の紹介）

引く対象の市町村の一覧（`src/town-tour/towns.json`）と日本地図（`public/town-tour/japan.topo.json`。各形の `properties.code` が一覧のコード）は、どちらも `scripts/town-tour/build-data.ts` が国土数値情報の N03 から作る生成物で、**手で直さない**。一覧と地図のコードの1対1は `src/town-tour/towns.test.ts` が検証する。

- 市町村の識別はコード（全国地方公共団体コードの5桁）で行う。名前は一意でない（北海道の泊村が2つある）ので、名前で探さない
- 政令市は市のコードで1件（市のコードは `DESIGNATED_CITY_CODES` の表）、東京23区は1区ずつ、北方領土の6村は入れ、所属未定地は外す
- 実行時に外部（geolonia など）へ一覧を取りに行かない。地図は Canvas 2D で描き、外部のタイルや MapLibre を持ち込まない

経緯は `docs/decisions/town-tour.md`、出典の表記と作り直しの手順は `docs/guide/town-tour.md`。
