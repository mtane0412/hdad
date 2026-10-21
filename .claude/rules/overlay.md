---
paths:
  - "src/overlay/**"
  - "overlay/**"
  - "worker/overlay-*.ts"
---

# 合成ページと構成の管理画面（`overlay/stage/`・`/overlay/`）

素材を重ねる合成ページ（`overlay/stage/index.html`）は、OBSに映すものを持つページのすべてを受け持つ1枚で（素材ごと・オーバーレイごとの単独ページは issue #107 で消した）、URLは `?key=` と `?overlay=<名前>` だけを取る。素材ごとに canvas を1枚持ち、`requestAnimationFrame` はオーバーレイで1本にし、同じオーバーレイの素材は接続（匿名IRC・ポーリング）を共有する（`stage.ts` の `createChatHub`・`poll.ts`）。1つの素材の失敗でほかの素材は動かし続け、失敗はその素材の箱の中だけに出す（`src/core/mount.ts` の `startCanvasLayer`・`showError`）。重ねうる素材のCSSは `src/overlay/overlay.css` が `@import` し、取りこぼしは `src/overlay/styles.test.ts` が検出する。→ `docs/decisions/overlay-stage.md`

構成を編集する管理画面（`/overlay/`。`src/overlay/overlay-page.tsx`）はオーバーレイをタブで1つずつ開き（開いているタブは名前で覚える。追加はタブの並びの横の＋の窓、OBS用URLはタブのすぐ下）、左にレイヤーの一覧（前に出るものから。`form.ts` の `frontFirstItems`。選んだ素材の設定はその行で開く）、右に表示領域（`StageEditor`。`sticky` で追従させるので、祖先に `overflow-hidden` を置かない。`Card` は既定で持つので外す）を並べる。素材はオーバーレイをまたいで移さない。値の検証は `worker/overlay-layout.ts` だけが持つので、画面は丸めずに送って返ってきた問題点を `describeOverlayProblem` で名前へ読み替える。素材の並べ替えは行のつまみのドラッグ&ドロップでもできる（同じオーバーレイの中だけ）。表示領域は合成ページを iframe に出すプレビュー（`src/overlay/preview.ts`。構成は postMessage で渡し、中身はすべてサンプル。動かすのは開いているタブの1つだけ）の上に透明な層を重ね、その上で素材を選び・ドラッグで動かし・選んだ素材のつまみで大きさを変える（計算は `src/overlay/drag.ts`）。選択はレイヤーと表示領域で1つを共有する。つまんだら `preventDefault` し、層が `setPointerCapture` で捕まえる（止めないとブラウザがポインタを取り消して手から離れる）。編集が進んだら同じプレビューへ構成を送り直し、合成ページは位置と大きさだけの変化なら箱を動かし（`layout.ts` の `rectsOnlyChanged`）、それ以外は読み込み直す（`stage.ts` の `watchPreviewLayout`）。→ `docs/decisions/overlay-editor.md`

素材は隠せる（`OverlayItem.hidden`。表示する素材では持たせない）。目のアイコンは保存ボタンを経ずに `PUT /api/admin/overlay/visibility` で保存済みの構成の1件だけを書き換え（指す場所は読み込んだ時点の中身から `form.ts` の `savedVisibilityTarget` で引き、種類とデザインIDが食い違えば Worker が409で拒む）、AlertChannel の目印 `overlayLayout` で合成ページへ構成を押し出す（保存ボタンでの保存も同じく押し出す）。合成ページは隠した素材を起動せず（`layout.ts` の `shownItems`）、押し出された構成で自分のオーバーレイの中身が変わったときだけ読み込み直す（`overlayChanged`）。→ `docs/decisions/overlay-editor.md`

下部バーの「演出を消す」（`src/overlay/dismiss-control.tsx`）は `POST /api/admin/overlay/dismiss` を呼び、Worker は締め切った意見ボードを片付けてから（`worker/opinion-store.ts` の `dismissClosedTheme`）、`AlertChannel` の目印 `dismiss` で合成ページへ中身の無い合図を押し出す（`src/overlay/dismiss.ts`）。合成ページは合図を1本の接続で受け（`stage.ts` の `watchDismiss`。プレビューではつながない）、起動した素材の `MountedItem.dismiss` を順に呼ぶ。消すのは再生中の1件だけで、待っている演出は捨てずに次へ進める。消し方を持つのはアラート・市町村紹介・ツイスター・ペロペロ・人形の獲得・漢字クイズ（解説に入ってからだけ。`kanjiQuizDismissibleAt`）・チャットで推理（終えたゲームだけ）で、参加している最中のもの・出しっぱなしの素材・VRM の反応は持たせない。→ `docs/decisions/overlay-stage.md`

利用者向けの説明は `docs/guide/overlay.md`。
