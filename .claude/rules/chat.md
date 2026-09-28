---
paths:
  - "src/chat/**"
---

# チャットボックス（素材の種類 `chat`）

チャットボックス（素材の種類 `chat`）だけは canvas ではなくHTML要素で表示し、届いた書き込みという状態を持つ。デザインは `src/chat/registry.ts` と `src/chat/<id>.css` の2か所に登録し（デザインごとの単独ページは issue #107 で消した）、各デザインのCSSは先頭で `src/chat/common.css` を `@import` し、`src/overlay/overlay.css` からも `@import` する。通信を伴わない変換（`irc.ts`・`event.ts`・`message.ts`・`emotes.ts`・`cheermotes.ts`）とDOM・WebSocketを扱う部分（`view.ts`・`connection.ts`）を分け、前者をテストする（`view.ts` だけは jsdom で要素・クラス・属性を確かめる）。匿名IRC（`justinfan`）でつなぐのでトークンを持たず、チャンネル名・公式バッジ・Cheermote は `/api/chat/*` から取る。→ `docs/decisions/chat.md`

利用者向けの説明は `docs/guide/chat.md`。
