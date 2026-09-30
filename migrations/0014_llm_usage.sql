-- LLMの使用状況（issue: LLMの設定ページで使用状況をモニターする）
--
-- 日時は 0001〜0013 と同じく UTC の ISO 8601 の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- LLMを呼んだ回数・トークン数・実費を、日ごとにまとめて持つ。
-- 記録するのは worker/llm.ts（LLMへの唯一の入口）で、管理画面（/llm/）が読み出して出す。
--
-- 1回の呼び出しで1行を追加するのではなく、「日 × 箇所 × 提供元 × モデル」の1行へ足し込む。
-- チャットの文面（aiChat）は視聴者の発言ごとに呼ばれるので、1呼び出し1行にすると行が際限なく増える。
-- どのモデルをどれだけ使ったかが分かれば足りるため、1件ごとの記録は残さない。
--
-- 日の区切りは UTC にする。配信者の暮らす時間帯（JST）ではなく、Workers AI の無料枠が UTC の日で
-- 切り替わるためである（画面にも「UTCの日で数えている」ことを書く）。
--
-- model を主キーに含めるのは、同じ箇所のモデルを日の途中で変えたときに、前のモデルのぶんと混ざらないようにするため。
-- 失敗（無料枠切れ・残高不足・推論モデルで本文が空）も回数として数える。collection_failures には
-- 最新の50件しか残らないので、「今日は何回失敗したか」をここから読めるようにしておく。
-- failures は calls に含めない（calls は文面を受け取れた回数）。
--
-- cost_usd は提供元が実費を返したときだけ積む。Workers AI は Neurons の消費量を応答に返さないので常に 0 で、
-- 使った量は呼び出し回数とトークン数から推し量ることになる（アカウント単位のAPIトークンを持たない方針のため、
-- Cloudflare側の集計は読めない。worker/llm-models.ts が一覧を手で持つのと同じ理由）。
CREATE TABLE llm_usage (
  -- UTC の日（YYYY-MM-DD）
  day TEXT NOT NULL,
  -- LLMを使う箇所（worker/llm-config.ts の LLM_USAGES）
  usage TEXT NOT NULL,
  -- 提供元（worker/llm-config.ts の LLM_PROVIDERS）
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- 文面を受け取れた回数
  calls INTEGER NOT NULL,
  -- 失敗した回数
  failures INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  -- 提供元が返した実費（米ドル）の合計。返さない提供元では 0 のまま
  cost_usd REAL NOT NULL,
  -- 最後に足し込んだ日時
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, usage, provider, model)
) WITHOUT ROWID;
