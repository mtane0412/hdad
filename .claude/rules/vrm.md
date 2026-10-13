---
paths:
  - "src/vrm/**"
  - "worker/vrm-*.ts"
  - "src/admin/vrm-card.tsx"
  - "src/speech/level*.ts"
---

# VRMのマスコット（動作 `vrm` と素材の種類 `vrm`）

配信者がアップロードした VRM のキャラクターを、合成ページに出しっぱなしで立たせるマスコット（issue #359。VRM の段階 B。段階 A #358 の「歩いて出てきて帰る演出」は置き換えた）。ふだんは待機の動き（呼吸・瞬き・視線のゆらぎ）を続け、トリガーの動作 `vrm`（相手を必要としないので**どの項目にも置ける**）とトリガー画面の試し再生（`POST /api/admin/vrm/demo`。`src/admin/vrm-card.tsx`）で、その場で手を振ってお辞儀する反応を重ねる。

- VRM は R2（`MEDIA`）の素材の種類 `vrm`（Content-Type `model/gltf-binary`。`worker/media.ts` の `VRM_CONTENT_TYPE`）。ブラウザは .vrm に種類を付けないので、管理画面（`src/admin/api.ts` の `contentTypeOf`）が拡張子を見て付けて送る。`application/octet-stream` は受け付けない。**VRM はアラートの素材にしない**（Worker は `parseAlertConfig` で拒み、画面は `src/admin/form.ts` の `alertMediaOf` で選択肢から外す）
- 出す VRM は全体で1つで、KV `vrm-model`（`worker/vrm-model.ts`。検証・保存・URL への置き換えはここだけ）に持つ。選ばれている素材は削除させない（`worker/admin-routes.ts`）。VRM を選んでいない・オーバーレイ用キーが無ければ押し出さない（トリガーは `vrm-push-failed`、試し再生は409）。合成ページはマスコットの VRM の URL を `GET /api/overlay/vrm/model?key=`（`getOverlayVrmModel`。選んでいなければ409）から、配送先につながるたびに読む
- Worker は動き方の種と VRM の URL だけを押し出す（`worker/vrm-call.ts`。形は `src/vrm/call.ts` の `parseVrmCall` と合わせる。URL は `/api/media/` に限る）。押し出し先は `AlertChannel` の目印 `vrm` の接続（`pushVrm`・`connectVrmSocket`）。当てはまった数は `worker/alert-event.ts` の `vrmsFor` が数え、`worker/alert-actions.ts` が bot の接続を見る前に押し出す
- 動き方は種と時刻だけから決まる。待機の動きは固定の種と現在時刻だけから（瞬きは区切り `BLINK_SLOT_MS` ごとに種と区切りの番号から時刻を決める）、反応は `src/vrm/motion.ts` の `createVrmPlan` が振る手・振る回数・お辞儀の深さを決める。`vrmSceneAt(現在時刻, 反応と経過時間)` が、待機の姿勢に反応を重ねた骨の回転・表情（にっこり・瞬き）を求める。反応のはじめと終わりは同じ時刻の待機の姿勢とつながるように、反応は待機の姿勢に足す形で重ねる。骨の回転は正規化された骨（T ポーズで 0、キャラクターは +Z を向き左手が +X）に当てる値で、手で作る（VRMA は使わない）。乱数は `src/core/background.ts` の `createRandom` だけを使う
- 口パクは音量で開け閉めするだけ（表情 `aa`。口の形は合わせない）。読み上げのページ（裏方の読み上げ・ワイプ）は `src/speech/voice.ts` で、鳴らす前に音声を読み解いて区切り（20ミリ秒）ごとの音量の列を作り（`src/speech/level.ts` の `envelopeOf`。いちばん大きい区切りを 1 にそろえ、無音は 0 のまま）、鳴りはじめ（`start`。時刻と列）と止まったとき（`stop`）を BroadcastChannel `hdad-speech-level` で配る（`src/speech/level-channel.ts`）。マスコットは受け取った列から、その時刻の口の開きを `vrmSceneAt` の第3引数で求める（毎コマ音を測らない。時刻だけから決まる）。知らせの形は `parseSpeechLevelMessage` だけが確かめ、違えば箱に失敗を出す
- 描画は `src/vrm/view.ts` で、テストを持たない。読み込んだ VRM は URL ごとに1つだけ持ち、読み込み中の同じ URL は同じ読み込みを待つ。**`vrm.update` は呼ばず、`humanoid.update`・`expressionManager.update` と、揺らす設定のときだけ `springBoneManager.update` を呼ぶ**。**髪や服の揺れ（SpringBone）は、経過時間だけから描く約束の例外**で、前のコマの状態から決まる。前のコマの時刻は `view.ts` だけが持ち、1コマで進める時間は `src/vrm/spring.ts` の `springStepSeconds`（上限 1/30 秒）で決める。揺れ物を時刻だけから決める形に書き直さない（例外の理由は `docs/decisions/vrm.md`）。素材のパラメータ `spring`（`src/vrm/params.ts`）は揺らすか硬いままにするかを OBS で見比べるための一時的なもので、決めたら消す。VRM 0.x は `rotateVRM0` で向きをそろえ、骨の X・Z の回転を反転して当てる。読み込みの時間は User Timing の `vrm-load` に残す
- 合成ページの素材の種類は `vrm`（`src/overlay/stage.ts` の `mountVrm`）。マスコットの VRM は接続のたびに `fetchMascotModelUrl`（`src/vrm/api.ts`）で読む。反応は届いた順に1件ずつ流し、読み込めなかった1件は箱に失敗を出して次へ進む。プレビュー（`?demo=true`）は押し出しにつながず、配信者のセッションで `GET /api/admin/vrm/model` を1回読んで（`fetchPreviewModelUrl`）マスコットを立たせ、`src/vrm/demo.ts` の種をくり返し流す

経緯は `docs/decisions/vrm.md`、使い方は `docs/guide/vrm.md`。
