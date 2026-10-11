---
paths:
  - "src/twister/**"
  - "worker/twister-*.ts"
  - "src/admin/twister-card.tsx"
---

# ツイスター（レイドで流す3Dのツイスターゲーム）

レイドした人と配信者が、three.js の3Dの人形でツイスターゲームをする演出（issue #272）。流すきっかけはトリガーの動作 `twister`（レイドの行だけ。`worker/alert-config.ts` で保存時に拒む）と、トリガー画面の試し再生（`POST /api/admin/twister/demo`）。

- Worker は対戦の種（0 以上 2^32 未満の整数）と2人（0番: レイドした人、1番: 配信者）の名前とアイコンの URL と BGM の設定だけを押し出す（`worker/twister-call.ts`）。押し出し先は `AlertChannel` の目印 `twister` の接続。対戦の中身（指示・倒れ方・勝敗）は Worker で計算しない（倒れ込みの物理が Workers Free の CPU の上限に収まらないため）
- レイドでは、アイコンは Worker が Twitch の `getProfileImageUrls` で2人ぶんを1回で引く。引けなければ押し出さずに `twister-push-failed` として記録する（試し再生は502）。Twitch が返さなかった人は `iconUrl: null` にし、合成ページは名前の頭文字の顔で流す
- 配信者の表示名はレイドの通知の `to_broadcaster_user_name` から取る（読み取りは `worker/alert-event.ts` の `extract` だけ）。試し再生はレイドの通知を持たないので、ログインした配信者の表示名とアイコンを Twitch から引く（ユーザーIDから `getUserLogin` でいまのログイン名を引き、`getUserByLogin` で引く。保管庫のトークンのログイン名は改名で古くなるので使わない。引けなければ502）。合成ページのプレビュー（`demo.ts`）だけは Worker を通らないので「配信者」と出す。試し再生の相手は、本文の `userName`（ログイン名）があれば `getUserByLogin` で引いた表示名とアイコン、無ければ「レイドした人（試し）」（アイコンなし）にする。いないログイン名は試しの相手に差し替えずに404で返す
- 対戦は種だけから決まる。`src/twister/game.ts` の `createGame` が指示の並びを決め（`plan.ts`）、倒れ込みを物理で先に計算して記録する（`physics.ts` の `bakeCollapse`）。場面と姿勢は再生を始めてからの経過時間だけから求める（`gameSceneAt`）。乱数は `src/core/background.ts` の `createRandom` だけを使い、`Math.random` を使わない
- 倒れ込むまでの姿勢は、その時刻の手足の位置から IK で解き（`pose.ts` の `solvePose`。肩・脚の付け根の線は手足の先の位置に合わせて回し傾け、角度は `MAX_TWIST_YAW`・`MAX_TWIST_ROLL` で止める）を目標にし、2人の体のめり込みを押し出して求める（重力も速度も持たない）。押し出しは前のコマの結果から目標を追いかけて解く（`physics.ts` の `relaxFollowing`）ので、倒れ込みと同じく対戦を作るときに1コマずつ記録し（`game.ts` の `bakeStanding`）、再生は記録を引くだけにする。毎コマ IK の姿勢から押し出し直さない（押す向きが裏返って姿勢が飛ぶ）。押し出しが落ち着き（1ビットも動かない）、目標の姿勢と運んでいる手足が前のコマとまったく同じあいだは、前のコマの記録を使い回す（そのため `relaxFollowing` は同じ入力から必ず同じ結果を返す形に保つ）。押し出しの反復の回数（`RELAX_ITERATIONS`）は、減らすとめり込みが深くなるので12回から減らさない。運んでいる途中の手足は留めず、運び終えた手足は前のコマの位置から円へ少しずつ寄せて留める。手足を運ぶ経路は、いまの弧で記録して関節が速く動いたか運び終えるのが遅れたときだけ、経路の候補（`path.ts` の `PATH_SHAPES`。順は固定）を同じ直前の状態から記録し直し、悪さ（`path.ts` の `windowScore`。突き抜けは骨どうしの線分の距離で測る）がいちばん小さい記録を残す（`bakeStanding`。同点なら先の候補。選んだ経路は `Game.paths`）。裏返る指示はいまの弧のまま運ぶ（`plan.ts` の `flipMidPose` がその弧を前提にするため）。手足の先を付け根へ寄せてよい距離の下限は `body.ts` の `LIMB_CHAINS` の `minSpan` だけが持ち、IK（`solveTwoBone`）と物理（`MIN_SPANS`）の両方がそれを使う。倒れ込むまでは、手足の先のほかの部位をマットから `STANDING_CLEARANCE` だけ浮かせておく
- 2人の胴が上から見て近づいたら、下になる人を伏せさせる（`pose.ts` の `solvePose` の `crouch`。度合いは胴の近さ（`plan.ts` の `crouchOf`）で連続して変える）。下になるのは、最初に胴が重なった指示で動いた人の相手で、その対戦のあいだ入れ替えない（`game.ts` の `underOf`・`stackingAt`）
- 勝敗は「手足の先のほかの部位（`body.ts` の `LOSING_JOINTS`）が先にマットに着いた人の負け」で、`bakeCollapse` だけが決める。倒れる人の相手は、ぶつかられるか一定の時間が過ぎるまで体を支えている
- 手の指示のうち多くても1人1回は、仰向けに裏返る指示（`plan.ts` の `Move.flip`）にする。裏返る途中は手を運ぶ進み具合だけから体を背骨のまわりに回し（`pose.ts` の `solvePose` の `supine`・`rollSide`）、裏返った人はその対戦のあいだ仰向けのまま解く。仰向けでは人形の左右が入れ替わるので、腕が胴の下をくぐる・脚どうしがめり込む置き場所（`isSelfClear`）と、回す途中にほかの3本が円から離れる置き場所と、相手の胴が近い置き場所は候補にしない
- 指示の選び方は `plan.ts` だけが持つ。絡ませる指示（5〜7回）は、空いていて届く円のうち相手の胴に近い円と、手足が上から見て交差する円（`crossingCount`）を優先し、最後の指示は届かない円を指す（純粋な乱数にしない）。体の向き（足から手へ）が始めの向きから `MAX_HEADING_TURN` を超える置き場所は、最後の指示で伸ばしきったところも含めて候補にしない（向きが裏返ると姿勢が飛ぶ）
- 1手の長さは `game.ts` の `paceOf` だけが決める（はじめの2手はゆっくり、3手目からと最後の指示は速い）。スピナーの針が止まる時刻は場面の `spin.turnMs` で渡し、文言とスピナーの描画はそれを見る
- 倒れ込みは記録を `COLLAPSE_PLAYBACK_RATE` の速さ（スローモーション）で再生する
- 画面に重ねる文言は `hud.ts`、スピナーの角度は `spinner.ts` が決める。描画は `view.ts`（3Dは WebGL の canvas、名札・スピナー・文言は上に重ねた2Dの canvas）で、`view.ts`・`face-loader.ts`・`bgm-player.ts` だけがテストを持たない
- アイコンは合成ページが Twitch の画像配信元から直接読む（`Access-Control-Allow-Origin: *` を返すので WebGL のテクスチャにできる）。読み込めなかった人は素材の箱に失敗を出し、頭文字の顔で流す（対戦は止めない）
- 対戦のあいだ流す BGM は、配信者がアップロードした音声1つと音量だけを設定に持つ（KV `twister-sound`。検証・保存・URL への置き換えは `worker/twister-sound.ts` だけ、管理画面は `src/admin/twister-card.tsx`）。Worker は呼び出しの `sound` に音声の URL（オーバーレイ用キーつき）を添える。BGM を選んでいるのにキーが無ければ押し出さない（レイドは `twister-push-failed`、試し再生は409）。選ばれている素材は削除させない（`worker/admin-routes.ts`）
- 合成ページは流しはじめたときに BGM を鳴らし、対戦の終わりに向けて下げて止める。いつ下げるか・配信の BGM をどれだけ下げておくかは `src/twister/bgm.ts` の `twisterBgmPlanOf` だけが決め、鳴らすのは `bgm-player.ts`（テストを持たない）。配信の BGM は市町村紹介と同じ `POST /api/overlay/bgm/duck` で下げる（プレビューでは送らない）
- 合成ページの素材の種類は `twister`（`src/overlay/stage.ts` の `mountTwister`）。届いた順に1件ずつ流す。プレビューでは `demo.ts` の決まった種をくり返し流す

経緯は `docs/decisions/twister.md`、使い方は `docs/guide/twister.md`。
