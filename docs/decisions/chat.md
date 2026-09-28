# チャットボックス（`chat/`）

チャットボックス（`chat/`）だけは canvas ではなくHTML要素で表示し、届いた書き込みという状態を持つ。

デザインは `chat/<id>/index.html`・`src/chat/registry.ts`・`src/chat/<id>.css` の3か所に登録する。

各デザインのCSSは先頭で `src/chat/common.css` を `@import` する（返信元・時刻・初見／おかえり・サブスク継続月数・ビッツ・Cheermote など、デザインによらず同じ役割で添える小さな要素の見た目をそこに置く）。

通信を伴わない変換（`irc.ts`・`event.ts`・`message.ts`・`emotes.ts`・`cheermotes.ts`）と、DOM・WebSocketを扱う部分（`view.ts`・`connection.ts`・`stage.ts`）を分け、前者をテストする。

`view.ts` だけは組み立てるHTML構造が増えたため、`// @vitest-environment jsdom` を付けて要素・クラス・属性を確かめる（jsdom には `Element.animate` が無いので差し替える）。

チャットは匿名IRC（`justinfan`）でつなぐためトークンを持たず、トークンが要るもの（接続先のチャンネル名・公式バッジ画像・Cheermote）を Worker の公開API（`/api/chat/*`）から取る（`channel.ts`・`badges.ts`・`cheermotes.ts`）。

映すチャンネルはこのWorkerの配信者に固定なので、URLに `channel` は無い（接続先は `/api/chat/channel` から受け取るため、`stage.ts` の起動は非同期）。

バッジ・Cheermote の取得に失敗しても表示は止めず、`addNotice` で画面に知らせる（バッジは自前のSVG、Cheermote は文字のまま）
