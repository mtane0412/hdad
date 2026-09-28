---
paths:
  - "src/overlay/**"
  - "overlay/**"
  - "worker/overlay-*.ts"
---

# 合成ページと構成の管理画面（`overlay/stage/`・`/overlay/`）

素材を重ねる合成ページ（`overlay/stage/index.html`）はOBSのブラウザソースの数を減らすための1枚で、URLは `?key=` と `?overlay=<名前>` だけを取る。素材ごとに canvas を1枚持ち、`requestAnimationFrame` はオーバーレイで1本にし、同じオーバーレイの素材は接続（匿名IRC・ポーリング）を共有する（`stage.ts` の `createChatHub`・`poll.ts`）。1つの素材の失敗でほかの素材は動かし続け、失敗はその素材の箱の中だけに出す（`src/core/mount.ts` の `startCanvasLayer`・`showError`）。重ねうる素材のCSSは `src/overlay/overlay.css` が `@import` し、取りこぼしは `src/overlay/styles.test.ts` が検出する。→ `docs/decisions/overlay-stage.md`

構成を編集する管理画面（`/overlay/`。`src/overlay/overlay-page.tsx`）はオーバーレイ1つを1枚のカードにし、その中に素材を並べる（一覧は前に出るものから。`form.ts` の `frontFirstItems`）。値の検証は `worker/overlay-layout.ts` だけが持つので、画面は丸めずに送って返ってきた問題点を `describeOverlayProblem` で名前へ読み替える。位置と大きさはドラッグでも決められ（`src/overlay/drag.ts`）、重なりと見た目は合成ページを iframe に出すプレビュー（`src/overlay/preview.ts`。構成は postMessage で渡し、中身はすべてサンプル）で確かめる。→ `docs/decisions/overlay-editor.md`

利用者向けの説明は `docs/guide/overlay.md`。
