---
paths:
  - "src/tab/**"
  - "extension/**"
  - "worker/tab-*.ts"
---

# タブの映像（`/tab/`・素材の種類 `tab`・`extension/`）

タブの映像は、Chrome のタブ1枚の映像と音を配信画面へ出す素材（素材の種類 `tab`）である。**拡張（`extension/`）はストリームIDを渡すだけ**で、取り込みと送信は送り手のページ（`/tab/`）が配信者のセッションで行う（拡張にログインや鍵を持たせない）。映像と音は送り手から合成ページへ WebRTC で同じPCの中を直接流れ、Worker を通るのはつなぐための連絡（`src/tab/signal.ts`）だけである。→ `docs/decisions/tab.md`

**拡張から送り手のページへは、URL の # でIDを渡す**（`chrome.tabs.update` で # だけを書き換える。ドメインの権限が要らないので、フォークごとに拡張を書き換えずに済む）。書式は `src/tab/signal.ts` の `buildStreamHash`・`readStreamHash` だけが持ち、拡張もこれを読み込む。送り手のページは「**信頼する置き場所（ビルドのときに `HDAD_ORIGINS` で渡す。`extension/src/origins.ts`）の、パスが `/tab/` のタブ**」で探し（パスだけで探すと別のサイトの `/tab/` にIDを渡してしまう）、無い・2つ以上ある・取り込めないときは**黙らずにバッジで知らせる**（`extension/src/hand-over.ts`）。送り手のページは読んだ # をすぐ消す。**IDは数秒で使えなくなるので、受け取ったらすぐ取り込む**。

**連絡の中継（`worker/tab-channel.ts` の `TabChannel`）は中身を読まず、両方向に配る**。送り手から届いたものは合成ページ全員へ、合成ページから届いたものは送り手へだけ配り、**合成ページどうしには配らない**（オーバーレイ用キーは配信画面に映りうるため）。送り手として受け入れるのはセッションで守られた経路（`worker/tab-routes.ts`）だけで、WebSocket は GET なので `Origin` を自分で確かめる（手書きと同じ）。合成ページ側の入口は `worker/overlay-routes.ts` の `overlayTabSocket`。

**接続は合成ページごとに1本**（合成ページは開くたびに `viewerId` を作って名乗る）。いつ名乗り・どの offer に応じ・いつ作り直すかは `src/tab/sender.ts`・`src/tab/receiver.ts` だけが持ち、`RTCPeerConnection` は `src/tab/peer.ts` に閉じ込める（ふるまいは接続を偽物に差し替えてテストする）。ICE は集め終えてから SDP にまとめて送る（trickle ICE の連絡を持たない）。

**映像は H.264 を優先し、送れないブラウザでは VP8 へ黙って切り替えずに失敗させる**（`preferH264`。負荷と遅延が大きく変わるため）。**接続が failed になったら送り手が作り直す**（閉じて名乗り直しを頼む）。

**タブを閉じた・映すのをやめた・接続が切れたときは、エラーにせず透明に戻す**（配信中に普通に起こる操作のため。状態は送り手のページにだけ出す）。合成ページの箱に失敗を出すのは、中継先につながらないときと再生できないときだけである。

拡張は `HDAD_ORIGINS=https://… npm run build:extension` で `extension/dist/` にビルドし（指定が無ければビルドを失敗させる）、型チェックは `tsconfig.extension.json`（`npm run type-check` に含まれる）。

利用者向けの説明は `docs/guide/tab.md`。
