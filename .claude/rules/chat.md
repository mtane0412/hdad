---
paths:
  - "src/chat/**"
  - "chat/**"
---

# チャットボックス（`chat/`）

チャットボックス（`chat/`）だけは canvas ではなくHTML要素で表示し、届いた書き込みという状態を持つ。デザインは `chat/<id>/index.html`・`src/chat/registry.ts`・`src/chat/<id>.css` の3か所に登録し、各デザインのCSSは先頭で `src/chat/common.css` を `@import` する。通信を伴わない変換（`irc.ts`・`event.ts`・`message.ts`・`emotes.ts`・`cheermotes.ts`）とDOM・WebSocketを扱う部分（`view.ts`・`connection.ts`・`stage.ts`）を分け、前者をテストする（`view.ts` だけは jsdom で要素・クラス・属性を確かめる）。匿名IRC（`justinfan`）でつなぐのでトークンを持たず、チャンネル名・公式バッジ・Cheermote は `/api/chat/*` から取る。→ `docs/decisions/chat.md`
