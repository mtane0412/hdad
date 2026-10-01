---
paths:
  - "src/llm/**"
  - "worker/llm*.ts"
  - "worker/jev*.ts"
  - "worker/ai-chat.ts"
  - "worker/side-super.ts"
  - "worker/viewer-summary.ts"
  - "worker/stream-summary.ts"
---

# LLMの呼び先・使用状況・モデルの選択

LLMを呼ぶのは4か所（`LLM_USAGES`: `aiChat`・`sideSuper`・`viewerSummary`・`streamSummary`。配信の章も `streamSummary` を指名する）だが、呼び先を決めるのは `worker/llm.ts` だけである。呼び出し側はモデル名ではなくどこで使うかを指名し、提供元（Workers AI・OpenRouter）とモデルは設定（`worker/llm-config.ts`。KVは `llm-settings`）が箇所ごとに決める。失敗は黙って別の提供元へ落とさない。使用状況は `worker/llm-usage-store.ts` が「日（UTC）× 箇所 × 提供元 × モデル」の1行へ足し込む。モデルは入力させず `worker/llm-models.ts` の候補から選ばせる。管理画面は `/llm/`。→ `docs/decisions/llm.md`

判定用のモデル Jev（TypeSafe）は文面を作らないので `llm.ts` には載せず、入口を `worker/jev.ts` の1か所に持つ。呼び出し側は使う箇所（`JEV_USAGES`）を指名し、Noul・Choice・Score の質問を1回にまとめて渡す。モデルは版を固定した `JEV_MODEL` で、設定で選ばせない。答えが欠けている・型が違う場合は投げる。使用状況は LLM と同じ `llm_usage` へ足し込み、`/llm/` の「判定に使う箇所」（`src/llm/api.ts` の `JEV_USAGES`）に並べて全体の合計にも含める。→ `docs/decisions/llm.md` の「判定には Jev を使う」

利用者向けの説明は `docs/guide/llm.md`。
