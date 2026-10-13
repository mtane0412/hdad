---
paths:
  - "src/vrm/**"
  - "worker/vrm-*.ts"
  - "src/admin/vrm-card.tsx"
---

# VRMの演出（動作 `vrm` と素材の種類 `vrm`）

配信者がアップロードした VRM のキャラクターが、トリガーで短いあいだだけ画面の端から歩いて出てきて、手を振り、お辞儀をして帰る演出（issue #358。VRM の段階 A）。流すきっかけはトリガーの動作 `vrm`（相手を必要としないので**どの項目にも置ける**）と、トリガー画面の試し再生（`POST /api/admin/vrm/demo`。`src/admin/vrm-card.tsx`）。

- VRM は R2（`MEDIA`）の素材の種類 `vrm`（Content-Type `model/gltf-binary`。`worker/media.ts` の `VRM_CONTENT_TYPE`）。ブラウザは .vrm に種類を付けないので、管理画面（`src/admin/api.ts` の `contentTypeOf`）が拡張子を見て付けて送る。`application/octet-stream` は受け付けない。**VRM はアラートの素材にしない**（Worker は `parseAlertConfig` で拒み、画面は `src/admin/form.ts` の `alertMediaOf` で選択肢から外す）
- 出す VRM は全体で1つで、KV `vrm-model`（`worker/vrm-model.ts`。検証・保存・URL への置き換えはここだけ）に持つ。選ばれている素材は削除させない（`worker/admin-routes.ts`）。VRM を選んでいない・オーバーレイ用キーが無ければ押し出さない（トリガーは `vrm-push-failed`、試し再生は409）
- Worker は動き方の種と VRM の URL だけを押し出す（`worker/vrm-call.ts`。形は `src/vrm/call.ts` の `parseVrmCall` と合わせる。URL は `/api/media/` に限る）。押し出し先は `AlertChannel` の目印 `vrm` の接続（`pushVrm`・`connectVrmSocket`）。当てはまった数は `worker/alert-event.ts` の `vrmsFor` が数え、`worker/alert-actions.ts` が bot の接続を見る前に押し出す
- 動き方は種と経過時間だけから決まる。`src/vrm/motion.ts` の `createVrmPlan` が出てくる側・帰る側・振る手・振る回数・お辞儀の深さを決め、`vrmSceneAt` がその時刻の位置・向き・骨の回転・表情を求める。骨の回転は正規化された骨（T ポーズで 0、キャラクターは +Z を向き左手が +X）に当てる値で、手で作る（VRMA は使わない）。乱数は `src/core/background.ts` の `createRandom` だけを使う
- 描画は `src/vrm/view.ts` で、テストを持たない。読み込んだ VRM は URL ごとに1つだけ持つ。**`vrm.update` を呼ばず `humanoid.update` と `expressionManager.update` だけを呼ぶ**（SpringBone は前のコマの状態から決まるので、経過時間だけから描く約束の例外になる。使うなら `docs/decisions/rendering.md` の書き方で例外として記録する。段階 B の #359）。VRM 0.x は `rotateVRM0` で向きをそろえ、骨の X・Z の回転を反転して当てる。読み込みの時間は User Timing の `vrm-load` に残す
- 合成ページの素材の種類は `vrm`（`src/overlay/stage.ts` の `mountVrm`）。届いた順に1件ずつ流し、読み込めなかった1件は箱に失敗を出して次へ進む。プレビュー（`?demo=true`）は押し出しにつながず、配信者のセッションで `GET /api/admin/vrm/model` を1回読んで（`src/vrm/api.ts` の `fetchPreviewModelUrl`）`src/vrm/demo.ts` の種をくり返し流す

経緯は `docs/decisions/vrm.md`、使い方は `docs/guide/vrm.md`。
