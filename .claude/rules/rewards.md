---
paths:
  - "src/admin/reward-*"
  - "worker/reward-*.ts"
---

# チャンネルポイント報酬（`/rewards/`）

チャンネルポイント報酬の管理画面（`/rewards/`。`src/admin/reward-page.tsx`）は、報酬の一覧・追加・編集・削除を受け持つ。扱う項目は名前・必要ポイント・説明・交換できるか・メッセージの入力を求めるか・背景色・待ち行列に入れないか・待機時間・1配信あたりの上限回数・1人あたりの上限回数の10個で、Helixの作成・更新で送れる項目のうち一時停止（`is_paused`）以外のすべてになる。入力の検証は Worker（`worker/reward-input.ts` の `parseRewardInput`）だけが持ち、画面は `src/admin/reward-form.ts` で下書きと送る内容を変換して問題点を欄の名前へ読み替える。経路は `worker/reward-routes.ts`（`GET`・`POST /api/admin/rewards`、`PATCH`・`DELETE /api/admin/rewards/:id`）。

- Twitchは同じ Client ID で作った報酬しか更新・削除させないので、一覧には `manageable` を添え、`false` の報酬には編集欄も削除のボタンも出さない
- 書き換えには配信者のトークンの `channel:manage:redemptions` が要る。無ければTwitchへ送る前に `missing-scope` で断り、ログインし直しを求める。一覧は `channel:read:redemptions` で読めるので、トリガーの管理画面はスコープが無くても使える
- トリガーに使われている報酬は削除させない（`reward-in-use`。素材の削除と同じ）
- 待機時間・上限回数は `null` を「制限なし」とする（画面の空欄。Twitchへは `is_*_enabled: false` だけを送る）。Twitchは無効の項目を 0 で返すので、応答を読むときに `null` へ読み替える。待機時間は60〜604800秒（60秒未満はTwitchの画面に出ないため）
- 画面にはTwitchの報酬のページ（`dashboard.twitch.tv/u/<login>/viewer-rewards/channel-points/rewards`）へのリンクを置く（画像などHDADで扱えない設定のため）
- 報酬の画像は表示だけにする（`imageUrl`。アップロードした画像が無ければTwitchの既定の画像。どちらも無ければ応答の形が違うとして投げる）。Helixは画像の登録・変更を受け付けない
- 交換の完了・返金（`PATCH .../redemptions`）は持たない

→ `docs/decisions/rewards.md`

利用者向けの説明は `docs/guide/rewards.md`。
