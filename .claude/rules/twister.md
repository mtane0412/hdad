---
paths:
  - "src/twister/**"
  - "worker/twister-*.ts"
  - "src/admin/twister-card.tsx"
---

# ツイスター（レイドで流す3Dのツイスターゲーム）

レイドした人と配信者が、three.js の3Dの人形でツイスターゲームをする演出（issue #272）。流すきっかけはトリガーの動作 `twister`（レイドの行だけ。`worker/alert-config.ts` で保存時に拒む）と、トリガー画面の試し再生（`POST /api/admin/twister/demo`）。

- Worker は対戦の種（0 以上 2^32 未満の整数）と2人（0番: レイドした人、1番: 配信者）の名前とアイコンの URL と BGM の設定だけを押し出す（`worker/twister-call.ts`）。押し出し先は `AlertChannel` の目印 `twister` の接続。対戦の中身（指示・倒れ方・勝敗）は Worker で計算しない（倒れ込みの物理が Workers Free の CPU の上限に収まらないため）
- アイコンは Worker が Twitch の `getProfileImageUrls` で2人ぶんを1回で引く。引けなければ押し出さずに `twister-push-failed` として記録する（試し再生は502）。Twitch が返さなかった人は `iconUrl: null` にし、合成ページは名前の頭文字の顔で流す
- 配信者の表示名はレイドの通知の `to_broadcaster_user_name` から取る（読み取りは `worker/alert-event.ts` の `extract` だけ）。試し再生はレイドの通知を持たないので「配信者」と出す。試し再生の相手は、本文の `userName`（ログイン名）があれば `getUserByLogin` で引いた表示名とアイコン、無ければ「レイドした人（試し）」（アイコンなし）にする。いないログイン名は試しの相手に差し替えずに404で返す
- 対戦は種だけから決まる。`src/twister/game.ts` の `createGame` が指示の並びを決め（`plan.ts`）、倒れ込みを物理で先に計算して記録する（`physics.ts` の `bakeCollapse`）。場面と姿勢は再生を始めてからの経過時間だけから求める（`gameSceneAt`）。乱数は `src/core/background.ts` の `createRandom` だけを使い、`Math.random` を使わない
- 倒れ込むまでの姿勢は、その時刻の手足の位置から IK で解き（`pose.ts` の `solvePose`）、2人の体のめり込みを押し出して求める（`physics.ts` の `relaxPoses`。重力も速度も持たない）。倒れ込むまでは、手足の先のほかの部位をマットから `STANDING_CLEARANCE` だけ浮かせておく
- 勝敗は「手足の先のほかの部位（`body.ts` の `LOSING_JOINTS`）が先にマットに着いた人の負け」で、`bakeCollapse` だけが決める。倒れる人の相手は、ぶつかられるか一定の時間が過ぎるまで体を支えている
- 指示の選び方は `plan.ts` だけが持つ。絡ませる指示（2回か3回）は、空いていて届く円のうち相手の胴に近い円を優先し、最後の指示は届かない円を指す（純粋な乱数にしない）
- 倒れ込みは記録を `COLLAPSE_PLAYBACK_RATE` の速さ（スローモーション）で再生する
- 画面に重ねる文言は `hud.ts`、スピナーの角度は `spinner.ts` が決める。描画は `view.ts`（3Dは WebGL の canvas、名札・スピナー・文言は上に重ねた2Dの canvas）で、`view.ts`・`face-loader.ts`・`bgm-player.ts` だけがテストを持たない
- アイコンは合成ページが Twitch の画像配信元から直接読む（`Access-Control-Allow-Origin: *` を返すので WebGL のテクスチャにできる）。読み込めなかった人は素材の箱に失敗を出し、頭文字の顔で流す（対戦は止めない）
- 対戦のあいだ流す BGM は、配信者がアップロードした音声1つと音量だけを設定に持つ（KV `twister-sound`。検証・保存・URL への置き換えは `worker/twister-sound.ts` だけ、管理画面は `src/admin/twister-card.tsx`）。Worker は呼び出しの `sound` に音声の URL（オーバーレイ用キーつき）を添える。BGM を選んでいるのにキーが無ければ押し出さない（レイドは `twister-push-failed`、試し再生は409）。選ばれている素材は削除させない（`worker/admin-routes.ts`）
- 合成ページは流しはじめたときに BGM を鳴らし、対戦の終わりに向けて下げて止める。いつ下げるか・配信の BGM をどれだけ下げておくかは `src/twister/bgm.ts` の `twisterBgmPlanOf` だけが決め、鳴らすのは `bgm-player.ts`（テストを持たない）。配信の BGM は市町村紹介と同じ `POST /api/overlay/bgm/duck` で下げる（プレビューでは送らない）
- 合成ページの素材の種類は `twister`（`src/overlay/stage.ts` の `mountTwister`）。届いた順に1件ずつ流す。プレビューでは `demo.ts` の決まった種をくり返し流す

経緯は `docs/decisions/twister.md`、使い方は `docs/guide/twister.md`。
