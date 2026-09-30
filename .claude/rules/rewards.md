---
paths:
  - "src/admin/reward-*"
  - "worker/reward-*.ts"
---

# チャンネルポイント報酬（`/rewards/`）

チャンネルポイント報酬の管理画面（`/rewards/`。`src/admin/reward-page.tsx`）は、報酬の一覧・追加・編集・削除を受け持つ。扱う項目は名前・必要ポイント・説明・交換できるか・メッセージの入力を求めるかの5つだけで、待機時間・上限回数・背景色などはTwitchの既定のままにする。入力の検証は Worker（`worker/reward-input.ts` の `parseRewardInput`）だけが持ち、画面は `src/admin/reward-form.ts` で下書きと送る内容を変換して問題点を欄の名前へ読み替える。経路は `worker/reward-routes.ts`（`GET`・`POST /api/admin/rewards`、`PATCH`・`DELETE /api/admin/rewards/:id`）。

- Twitchは同じ Client ID で作った報酬しか更新・削除させないので、一覧には `manageable` を添え、`false` の報酬には編集欄も削除のボタンも出さない
- 書き換えには配信者のトークンの `channel:manage:redemptions` が要る。無ければTwitchへ送る前に `missing-scope` で断り、ログインし直しを求める。一覧は `channel:read:redemptions` で読めるので、トリガーの管理画面はスコープが無くても使える
- トリガーに使われている報酬は削除させない（`reward-in-use`。素材の削除と同じ）
- 交換の完了・返金（`PATCH .../redemptions`）は持たない

→ `docs/decisions/rewards.md`

利用者向けの説明は `docs/guide/rewards.md`。
