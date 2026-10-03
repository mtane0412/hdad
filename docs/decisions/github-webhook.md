# GitHub の Webhook（開発の出来事をトリガーのきっかけにする）

作者の作業配信の中身は、主に AIエージェント（Claude Code）でこの HDAD を作ることである。コミットや PR のマージといった進んだ瞬間は画面からは分からず、地味な作業に区切りの演出が無かった。そこで GitHub の Webhook を受ける口（`POST /api/github/webhook`。`worker/github-routes.ts`）を足し、トリガーの既定メニューに区分「開発」（`commitPushed`・`pullRequestMerged`）を足した（issue #210）。アラート・botの書き込みは既存の動作をそのまま使う。

## 受け口を分け、実行は Twitch の通知と同じ入口に通す

Twitch の EventSub の受け口（`worker/webhook-routes.ts`）に混ぜず、別の経路にした。署名の作り方（GitHub は本文だけに HMAC をかけ、EventSub はメッセージIDと時刻も含める）も、ヘッダーも、再送の見分け方も違うためである。一方で、照合と実行は `worker/alert-actions.ts` の `runAlertActions` をそのまま呼ぶ。照合（`matches`）・鍵の確保（`reserveChatReply`）・失敗の記録を2か所に持たないためである（`.claude/rules/implementation.md` の「判定と検証は1か所だけが持つ」）。

出来事の種別は Workerが付けた名前（`github.push`・`github.pull_request.merged`。`worker/trigger-menu.ts` の `ALERT_EVENTS`）で、Twitch の `subscription.type` と同じ位置で照合に回す。GitHub の通知の本文は Twitch の通知の `event` に当たる位置へ置き、`worker/alert-event.ts` の `extract` が読む（通知を2か所で読み解かない）。どの GitHub の通知をどの種別にするかの振り分け（タグの push・マージしない PR を外す）だけは `worker/github-webhook.ts` の `githubAlertEventOf` が持つ。

## push は main に限らず、すべてのブランチを対象にする

issue では「main へのコミット」としていたが、実装の時点で全ブランチに改めた。作者の運用では main へ直接コミットしない（PR を通してマージする）ので、main への push は PR の squash マージで起きるものだけになり、「PRがマージされた」と同じ瞬間に2つ鳴るだけになるためである。全ブランチにすれば、機能ブランチで Claude Code がコミットして push するたびに鳴り、作業の途中の区切りも拾える。

ただし、タグの push・ブランチの削除・新しいコミットを含まない push（既存のコミットからブランチを作っただけ）は外す。最後のものは `head_commit` に既存のコミットが入るので、鳴らすと古いコミットのメッセージが配信に出てしまう。新しく作ったブランチの push では `commits` に既存のコミットが並ぶこともあるので、件数ではなく、GitHub が各コミットに付ける `distinct`（以前に push されたことがないか）が1件でも true かで見分ける。

## 差し込み語

`{user}` は GitHub のユーザー名で、Twitch のユーザーではない。push では `pusher.name`（push の通知では `sender` が省略されうるため）、PR のマージでは `sender.login`（マージした人）を読む。`{repo}` は owner を含まない名前（`repository.name`）にした。Webhook を設定するのは配信者自身のリポジトリなので owner は決まっており、配信に出すには短いほうが読みやすいためである。push のコミットのメッセージは `{message}` で、チャットの発言の本文と同じ語にそろえた（どちらも「その出来事の本文」で、配信者が覚える語を増やさない）。1行目だけを差し込むのは、2行目以降の本文が長く、配信に出す文言に向かないためである。

## 配信していないときに届いた出来事は捨てる

配信外の作業で、Twitch のチャットに bot が書き込んだり、合成ページを開いていないあいだに押し出したアラートが宙に浮いたりしないようにするためである。配信中かどうかは `stream_sessions` の配信中の区切りで決める（`worker/screen-store.ts` の `isStreaming`。配信画面の取り込みが Gyazo へ上げる前に見ているものと同じ）。

捨てたときは黙って 204 にせず、理由（`not-streaming`・`not-a-trigger`）を本文に書いて 200 を返す。GitHub の Recent Deliveries から「なぜ鳴らなかったか」を読めるようにするためである（方針6）。

## 受け付けるリポジトリは「Webhook を設定したリポジトリ」とみなす

受け付けるリポジトリの一覧を設定として持つ案もあったが、採らなかった。GitHub には個人アカウント単位の Webhook が無く、配信者がリポジトリごとに Webhook を設定するので、設定したこと自体が選んだことになるためである（設定項目を増やさない。方針1）。非公開のリポジトリのコミットメッセージが配信に出るのを防ぐ責任は、そのリポジトリに Webhook を設定するかどうかの判断に置いた（利用者向けの説明 `docs/guide/deploy.md` に明記している）。

## 署名・鍵・再送

署名（`X-Hub-Signature-256`）は届いた文字列そのものに対して確かめ、中身はそのあとで読む。鍵（`GITHUB_WEBHOOK_SECRET`）は任意のシークレットにした。Deploy to Cloudflare ボタンは `.dev.vars.example` の有効な行をすべて必須の入力として求めるので、使わない人にまで入力させないよう、ほかの任意の鍵（`OPENROUTER_API_KEY` など）と同じくコメントアウトして説明だけを添えた（そのため `package.json` の `cloudflare.bindings` には入れない）。鍵が無いのに通知が届いたら、署名を確かめずに通すことはせず 500（`misconfigured`）にする。

Webhook の Content type の既定は `application/x-www-form-urlencoded` なので、選び忘れると本文が JSON で届かない。黙って読めない本文として扱わず、直し方を書いた 400 にする。扱わない種類の出来事（`issues` など）も 400 にして、Webhook の設定で選ぶ出来事の誤りに Recent Deliveries の失敗から気付けるようにした。

再送で二重に実行しないよう、動作ごとの鍵は `X-GitHub-Delivery` から作る（GitHub の Redeliver は同じ値を使う）。Twitch のメッセージIDと同じ表（`replied_chat_messages`）に書くので、頭に `github:` を付けて取り違えないようにした。GitHub の通知には時刻のヘッダーが無いので、EventSub のように古い通知を拒むことはしない。盗み見た通知の使い回しは、鍵が残っているあいだ（`chat-store.ts` の保持期間）は鍵で弾かれる。

## 別の issue に分けたもの

「テストが全部通った」のような手元の出来事を Claude Code の hooks から送る案は、認証の決め方が別に要るので、この issue には含めなかった。
