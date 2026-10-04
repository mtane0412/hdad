---
paths:
  - "src/llm/**"
  - "worker/llm*.ts"
  - "worker/jev*.ts"
  - "worker/ai-chat.ts"
  - "worker/side-super.ts"
  - "worker/viewer-summary.ts"
  - "worker/stream-summary.ts"
  - "worker/town-tour.ts"
---

# LLMの呼び先・使用状況・モデルの選択

LLMを呼ぶのは6か所（`LLM_USAGES`: `translation`・`aiChat`・`sideSuper`・`viewerSummary`・`streamSummary`・`townTour`。`townTour` は市町村紹介（`worker/town-tour.ts`）で、合成ページから呼ばれるたびに作る。配信の章も `streamSummary` を指名する。`translation` は字幕の翻訳の提供元に LLM を選んだときだけ `worker/translation.ts` が指名する）だが、呼び先を決めるのは `worker/llm.ts` だけである。呼び出し側はモデル名ではなくどこで使うかを指名し、提供元（Workers AI・OpenRouter）とモデルは設定（`worker/llm-config.ts`。KVは `llm-settings`）が箇所ごとに決める。失敗は黙って別の提供元へ落とさない。使用状況は `worker/llm-usage-store.ts` が「日（UTC）× 箇所 × 提供元 × モデル」の1行へ足し込む。モデルは入力させず `worker/llm-models.ts` の候補から選ばせる。管理画面は `/llm/`。→ `docs/decisions/llm.md`

**箇所を足したら、保存済みの `llm-settings` に無い箇所だけ読み出しで既定を補う**（`loadLlmSettings` の `fillAddedUsages`。キーがあって中身が壊れているものは補わず拒む。保存（PUT）の検証は補わない）。字幕の翻訳の m2m100・DeepL は LLM ではないが、使用状況は `llm_usage` の箇所 `translation` へ足し込む（提供元の型は `UsageProvider`。DeepL は `deepl`）。

判定用のモデル Jev（TypeSafe）は文面を作らないので `llm.ts` には載せず、入口を `worker/jev.ts` の1か所に持つ。呼び出し側は使う箇所（`JEV_USAGES`）を指名し、Noul・Choice・Score の質問を1回にまとめて渡す。モデルは版を固定した `JEV_MODEL` で、設定で選ばせない。答えが欠けている・型が違う場合は投げる。使用状況は LLM と同じ `llm_usage` へ足し込み、`/llm/` の箇所の表に LLM の箇所と並べて（`src/llm/api.ts` の `JEV_USAGES`）全体の合計にも含める。→ `docs/decisions/llm.md` の「判定には Jev を使う」

利用者向けの説明は `docs/guide/llm.md`。
