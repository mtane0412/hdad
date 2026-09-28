---
paths:
  - "src/llm/**"
  - "worker/llm*.ts"
  - "worker/ai-chat.ts"
  - "worker/side-super.ts"
  - "worker/viewer-summary.ts"
  - "worker/stream-summary.ts"
---

# LLMの呼び先・使用状況・モデルの選択

LLMを呼ぶのは4か所（`LLM_USAGES`: `aiChat`・`sideSuper`・`viewerSummary`・`streamSummary`）だが、呼び先を決めるのは `worker/llm.ts` だけである。呼び出し側はモデル名ではなくどこで使うかを指名し、提供元（Workers AI・OpenRouter）とモデルは設定（`worker/llm-config.ts`。KVは `llm-settings`）が箇所ごとに決める。失敗は黙って別の提供元へ落とさない。使用状況は `worker/llm-usage-store.ts` が「日（UTC）× 箇所 × 提供元 × モデル」の1行へ足し込む。モデルは入力させず `worker/llm-models.ts` の候補から選ばせる。管理画面は `/llm/`。→ `docs/decisions/llm.md`

利用者向けの説明は `docs/guide/llm.md`。
