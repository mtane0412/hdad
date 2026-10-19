---
paths:
  - "src/core/text-outline.css"
  - "src/core/outlined-text.ts"
  - "src/**/*.css"
  - "src/**/view.ts"
  - "src/clock/**"
  - "overlay/stage/index.html"
---

# 合成ページの文字の縁取りと書体

合成ページで**地（板・カード・ふきだし）を持たずに配信の映像の上へ直に置く文字には、必ず縁を付ける**。配信の背景は明るいことも暗いことも柄があることもあるため。地の上に置く文字には付けない。

- DOM の素材は `text-shadow: var(--text-outline)` と書く（`src/core/text-outline.css`。`src/overlay/overlay.css` が素材のCSSより先に読み込む）。色は `--outline-color`、太さは `--outline-width`（既定 0.08em）で変える。`-webkit-text-stroke` や8方向の影を素材ごとに書かない
- canvas の素材は `src/core/outlined-text.ts` の `drawOutlinedText` で描く（外に見える縁は文字の大きさの `OUTLINE_RATIO`＝0.08。角は丸める）。`strokeText` を素材ごとに書かない
- 2つの太さは同じ割合に揃える。変えるときは両方を直す
- 縁の色は塗りと明暗が逆の色にし、不透明にする（明るい塗りには暗い縁、暗い塗りには明るい縁。半透明の縁は明るい映像の上で薄れる）。目立たせたい素材（アラート）は太さだけ上げてよい
- 縁を付けた文字を `opacity` で薄くしない（縁まで透ける）。控えめにしたいときは大きさで差を付ける
- 文字を `overflow: hidden` の箱に入れるときは、縁の幅だけ内側に余白を取る（左右の縁が切れる）
- 例外: サイドスーパーの本文は塗りにグラデーションを載せるため（塗りが透明だと text-shadow が透けて見える）、`filter: drop-shadow` で縁取る（`src/side-super/side-super.css`）

合成ページの書体は `overlay/stage/index.html` の Google Fonts だけで読み込む。**素材のCSSで書体か太さを足したら、そこにも足す**（読み込んでいない太さは近い太さで代用されたり、無理に太らされたりする）。

経緯は `docs/decisions/text-outline.md`。
