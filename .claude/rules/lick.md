---
paths:
  - "src/lick/**"
  - "worker/lick-*.ts"
  - "src/admin/lick-card.tsx"
---

# ペロペロ（動作 `lick` と素材の種類 `lick`）

相手の Twitch のアイコンを、three.js の3Dの舌が下から舐め上げるジョーク演出（issue #337〜#340）。キモいほどウケるので、上品にまとめずリアル寄りのキモさを優先する。流すきっかけはトリガーの動作 `lick`（チャンネルポイント `reward` と「決まった人のその配信で最初の発言」`fromUserFirstOfStream` の行だけ。`worker/alert-config.ts` の `LICK_KINDS` で保存時に拒む）と、トリガー画面の試し再生（`POST /api/admin/lick/demo`。`src/admin/lick-card.tsx`）。

- Worker は舐め方の種（0 以上 2^32 未満の整数）と、舐める相手1人の名前とアイコンの URL だけを押し出す（`worker/lick-call.ts`。形は `src/lick/call.ts` の `parseLickCall` と合わせる）。押し出し先は `AlertChannel` の目印 `lick` の接続（`pushLick`・`connectLickSocket`）。舐め方は Worker で計算しない
- 舐める相手は `worker/alert-event.ts` の `licksFor` が決める（交換した人・発言した人）。アイコンは `worker/alert-actions.ts` が1件ごとにログイン名から `getUserByLogin` で引く。その人が Twitch にいなければ `iconUrl: null`（頭文字の顔）で流し、Twitch を呼べなければ押し出さずに `lick-push-failed` として記録する。bot の接続を見る前に押し出す
- 試し再生の相手は、本文の `userName`（ログイン名）があれば `getUserByLogin` で引いた表示名とアイコン、無ければ「視聴者（試し）」（アイコンなし）にする。本文の読み取りはツイスターと共有する（`worker/demo-user.ts` の `readDemoUser`。形の違いは400、いない人は404）
- 舐め方は種だけから決まる。`src/lick/motion.ts` の `createLickPlan` が舐める回数・横の位置・傾きを決め（回を重ねるごとに1回の長さを縮め、速く・しつこくする）、場面は流しはじめてからの経過時間だけから求める（`lickSceneAt`。フレーム間の状態を持たない）。乱数は `src/core/background.ts` の `createRandom` だけを使う
- 描画は `src/lick/view.ts`（3Dは WebGL の canvas、名前の文言は上に重ねた2Dの canvas）で、テストを持たない。アイコンはツイスターと同じ `src/twister/face-loader.ts` で読み、読み込めなければ素材の箱に失敗を出して頭文字の顔で流す
- 合成ページの素材の種類は `lick`（`src/overlay/stage.ts` の `mountLick`）。届いた順に1件ずつ流す。プレビューでは `src/lick/demo.ts` の決まった種をくり返し流す

経緯は `docs/decisions/lick.md`、使い方は `docs/guide/lick.md`。
