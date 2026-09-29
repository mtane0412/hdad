---
paths:
  - "src/**"
  - "worker/**"
---

# 判定・検証の置き場とテストの分け方

## 判定と検証は1か所だけが持つ

同じ判断を2か所に書き分けると必ず食い違うので、**判断の持ち主を1つに決めてほかは通り道にする**。

- **値の検証は Worker だけが持つ**（`worker/overlay-layout.ts`・`speech-config.ts`・`focus-config.ts`・`bot-config.ts`・`moderation-config.ts`・`llm-config.ts`。どれも問題点をすべて集めてから拒む）。画面は空欄を 0 に丸めず NaN のまま送り、返ってきた問題点を送った順の名前へ読み替えて並べる（`describeProblem`・`describeOverlayProblem`）
- **手書きの線1本ぶんとして読めるかの判定は `src/draw/strokes.ts` の `isStroke` だけが持つ**（`worker/draw-config.ts` の検証も `src/draw/api.ts` の応答の確かめもこれを呼ぶ。選べる色と太さの一覧が `src/draw/tools.ts` にあるため、Workerから `src/draw/` を読み込む唯一の例外になっている）。→ `.claude/rules/draw.md`
- **LLMの呼び先を決めるのは `worker/llm.ts` だけ**で、呼び出し側はモデル名ではなく使う箇所（`LLM_USAGES`）を指名する。→ `.claude/rules/llm.md`
- **トリガーの照合は `worker/alert-event.ts` の `matches` だけが持ち**、展開後の形しか見ない（展開は `trigger-menu.ts` の `expandSource`）。→ `.claude/rules/alerts.md`
- **何を映すかの判断は `src/focus/focused.ts` だけが持つ**（通信もDOMも持ち込まない）。→ `.claude/rules/focus.md`
- **Durable Object は配送者（`AlertChannel`）・時計（`AdBreakTimer`）であって判定者ではない**（設定を持たせると管理画面での変更がすぐ反映される性質が壊れる）
- **同じ通知を2か所で読み解かない**（発言の読み取りは `worker/chat-command.ts` の `readChatMessage` に集め、`alert-event.ts` の `extract` からも呼ぶ）。同じ数を2か所に書かない（素材の推奨の大きさは `src/overlay/layout.ts` の `RECOMMENDED_ITEM_SIZES` だけ、ポートの検証は `src/transcript/url.ts` の `assertTranscriptPort` を共有する）

## 通信とDOMを持たない部分に切り出してテストする

- **通信を伴わない変換と、DOM・WebSocketを扱う部分を分け、前者をテストする**（素材・裏方・アプリのページで同じ分け方。Workerの呼び出し（`api.ts`）とURLの組み立て（`url.ts`）は `fetch` を差し替えてテストし、入力欄の値の変換は `form.ts` に分ける）
- **`fetch`・現在時刻・KV・R2・D1は引数で受け取り、テストでは差し替える**（代役は `worker/fake-*.ts`）。→ `.claude/rules/worker.md`
- **LLMを呼ぶ処理では、材料を組み立てる関数だけをテストする**（`buildPrompt`・`buildSummaryPrompt`・`buildStreamSummaryPrompt`・`buildSideSuperPrompt`）
- **純粋な関数に保つため、通知の中身から決まらないものは引数で受け取る**（`ConditionState`・連投の件数・差し込む値）
- コンポーネントのテストは `// @vitest-environment jsdom` を付けて Testing Library で書く（`.claude/CLAUDE.md` の shadcn/ui の項）

経緯は `docs/decisions/llm.md`・`docs/decisions/focus.md`・`docs/decisions/alerts-overlay.md`・`docs/decisions/worker.md` にある。このリポジトリ全体の開発方針は `docs/principles.md`。
