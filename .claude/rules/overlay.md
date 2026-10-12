---
paths:
  - "src/overlay/**"
  - "overlay/**"
  - "worker/overlay-*.ts"
---

# 合成ページと構成の管理画面（`overlay/stage/`・`/overlay/`）

素材を重ねる合成ページ（`overlay/stage/index.html`）は、OBSに映すものを持つページのすべてを受け持つ1枚で（素材ごと・オーバーレイごとの単独ページは issue #107 で消した）、URLは `?key=` と `?overlay=<名前>` だけを取る。素材ごとに canvas を1枚持ち、`requestAnimationFrame` はオーバーレイで1本にし、同じオーバーレイの素材は接続（匿名IRC・ポーリング）を共有する（`stage.ts` の `createChatHub`・`poll.ts`）。1つの素材の失敗でほかの素材は動かし続け、失敗はその素材の箱の中だけに出す（`src/core/mount.ts` の `startCanvasLayer`・`showError`）。重ねうる素材のCSSは `src/overlay/overlay.css` が `@import` し、取りこぼしは `src/overlay/styles.test.ts` が検出する。→ `docs/decisions/overlay-stage.md`

構成を編集する管理画面（`/overlay/`。`src/overlay/overlay-page.tsx`）はオーバーレイ1つを1枚のカードにし、その中に素材を並べる（一覧は前に出るものから。`form.ts` の `frontFirstItems`）。値の検証は `worker/overlay-layout.ts` だけが持つので、画面は丸めずに送って返ってきた問題点を `describeOverlayProblem` で名前へ読み替える。素材の並べ替えは行のつまみのドラッグ&ドロップでもでき（同じオーバーレイの中だけ）、位置と大きさはドラッグでも決められ（`src/overlay/drag.ts`）、重なりと見た目は合成ページを iframe に出すプレビュー（`src/overlay/preview.ts`。構成は postMessage で渡し、中身はすべてサンプル）で確かめる。→ `docs/decisions/overlay-editor.md`

素材は隠せる（`OverlayItem.hidden`。表示する素材では持たせない）。目のアイコンは保存ボタンを経ずに `PUT /api/admin/overlay/visibility` で保存済みの構成の1件だけを書き換え（指す場所は読み込んだ時点の中身から `form.ts` の `savedVisibilityTarget` で引き、種類とデザインIDが食い違えば Worker が409で拒む）、AlertChannel の目印 `overlayLayout` で合成ページへ構成を押し出す。合成ページは隠した素材を起動せず（`layout.ts` の `shownItems`）、押し出された構成で自分のオーバーレイの中身が変わったときだけ読み込み直す（`overlayChanged`）。→ `docs/decisions/overlay-editor.md`

利用者向けの説明は `docs/guide/overlay.md`。
