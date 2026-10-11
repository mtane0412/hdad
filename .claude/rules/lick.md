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
- 舐め方は種だけから決まる。`src/lick/motion.ts` の `createLickPlan` が舐める回数・横の位置・傾き・跡から垂れる唾液を決め（回を重ねるごとに1回の長さを縮め、速く・しつこくする。最後の1回だけ舌先を丸めてすくう `scoop`）、場面は流しはじめてからの経過時間だけから求める（`lickSceneAt`。舌先の押しつぶれ `squash` と丸め `curl` もここで決める）。舐めた跡（`trailsAt`。濡れ具合が下がり、垂れが伸びる）と唾液の糸（`salivaStringAt`。舌を離しはじめてから伸びて切れる）も経過時間だけから求め、フレーム間の状態を持たない。乱数は `src/core/background.ts` の `createRandom` だけを使う
- 舌の形は `src/lick/tongue-shape.ts` の `tongueSurfacePoint`（中央の溝・丸い舌先・押しつぶれ・丸め）、模様は `src/lick/texture.ts`（表は乳頭のブツブツ・溝・奥の苔の色と凹凸、裏は青い血管）がコードで作る。画像の素材は使わない
- 描画は `src/lick/view.ts` で、テストを持たない。奥から「アイコン → 舌 → ガラス」の順に置き、舌は表をカメラへ向けてガラス越しにアイコンを舐める（舐めた跡はガラスの板に毎コマ描き直す）。舌は clearcoat を持つ物理ベースの材質で、部屋の照り返しを映して濡れて見せる。唾液の糸と名前の文言は上に重ねた2Dの canvas に描く。アイコンはツイスターと同じ `src/twister/face-loader.ts` で読み、読み込めなければ素材の箱に失敗を出して頭文字の顔で流す
- 舌が触れるたびに鳴らす効果音は、配信者がアップロードした音声1つと音量だけを設定に持つ（KV `lick-sound`。検証・保存・URL への置き換えは `worker/lick-sound.ts` だけ、管理画面は `src/admin/lick-card.tsx`）。Worker は呼び出しの `sound` に音声の URL（オーバーレイ用キーつき）を添える。効果音を選んでいるのにキーが無ければ押し出さない（トリガーは `lick-push-failed`、試し再生は409）。選ばれている素材は削除させない（`worker/admin-routes.ts`）
- 鳴らす時刻と音程は `src/lick/sound-cues.ts` の `lickSoundCuesOf` だけが決める（舌先が触れはじめる時刻 `strokeContactMs` に1回ずつ、音程は種から `MIN_PITCH`〜`MAX_PITCH`）。鳴らすのは `src/lick/sound-player.ts`（タイマーで数え、合図ごとに Audio 要素を作って重ねて鳴らす。`preservesPitch` を切って速さで音程を変える。テストを持たない）
- 合成ページの素材の種類は `lick`（`src/overlay/stage.ts` の `mountLick`）。届いた順に1件ずつ流す。プレビューでは `src/lick/demo.ts` の決まった種をくり返し流す

経緯は `docs/decisions/lick.md`、使い方は `docs/guide/lick.md`。
