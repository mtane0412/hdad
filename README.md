# stream-assets

Twitch配信用の各種素材を置くリポジトリです。Cloudflare Workers の静的アセットとして公開し、OBSのブラウザソースからURLで読み込みます。

ページUI（ダッシュボード・ギャラリー・アラートの管理画面）は、配信者のTwitchログインを前提にしたサイドバー付きのアプリです（`npm run dev` の中でWorkerも動くので、開発サーバーでもログインできます）。トップの `index.html` ひとつでできていて、`/wallpaper/` のようなパスに応じた中身をアプリが描きます。ログインしていなければ、どのパスを開いてもログインの入口だけが出ます。OBSに載せる素材ページはパスごとの実ファイルで、ログインなしで動きます。素材はカテゴリごとにディレクトリを分けて置きます。

| パス | 内容 |
| --- | --- |
| `/` | ダッシュボード（アプリ） |
| `/wallpaper/`・`/clock/`・`/chat/` | 各カテゴリのギャラリー（アプリ）。素材を選び、パラメータを調整して、OBS用のURLをコピーする |
| `/admin/` | アラートの管理画面（アプリ） |
| `/bot/` | チャットボットの管理画面（アプリ）。botアカウントの接続・切断、テスト送信、コマンドと自動モデレーションの設定 |
| `wallpaper/<id>/` | 配信画面の背景（壁紙）の各ページ |
| `clock/<id>/` | 配信画面に重ねる時計の各ページ |
| `chat/<id>/` | Twitchのチャット欄を配信画面に重ねるチャットボックスの各デザインのページ |
| `alerts/` | Twitchのイベント（チャンネルポイント交換）で画像・動画・音声を流すアラート用オーバーレイ。単独のページ |

## 壁紙（`wallpaper/`）

ギャラリー（`wallpaper/`）で背景を選び、パラメータを調整して、表示されたURLをOBSにコピーします。

```
https://stream-assets.<サブドメイン>.workers.dev/wallpaper/<背景ID>/?<パラメータ>=<値>&...
```

- **パス**で背景の種類を、**クエリパラメータ**で色や速さを切り替えます
- 色は `#` なしの16進数（`ff0080` または `f08`）で指定します。`bg` には `transparent`（透過）も指定できます
- 省略したパラメータは既定値になります。不正な値や未対応のパラメータ名は、既定値には戻さず画面にエラーを表示します

| 背景ID | 内容 | パラメータ |
| --- | --- | --- |
| `aurora` | ぼけた色の霧がゆっくり漂う | `colors`（カンマ区切り2〜6色）, `bg`, `speed` |
| `clouds` | もこもこの雲がゆっくり横へ流れる | `color`, `bg`, `count`（雲の数）, `speed` |
| `contour` | 地形図の等高線がゆっくり形を変える | `color`, `bg`, `levels`（本数）, `scale`（模様の大きさ）, `speed` |
| `grid` | 地平線へ伸びる床のグリッドが手前へ流れる | `color`, `bg`, `size`（下端でのマスの幅px）, `speed` |
| `halftone` | 印刷の網点が波打つ | `color`, `bg`, `size`（点の間隔px）, `speed` |
| `hearts` | パステルカラーのハートが揺れながら昇る | `colors`（カンマ区切り1〜6色）, `bg`, `count`（ハートの数）, `speed` |
| `motes` | やわらかい光の粒が揺れながら昇る | `color`, `bg`, `count`（粒の数）, `speed` |
| `polka` | 水玉が波の伝わるように伸び縮みする | `colors`（カンマ区切り1〜6色）, `bg`, `size`（水玉の間隔px）, `speed` |
| `sparkles` | きらきらがあちこちでまたたく | `colors`（カンマ区切り1〜6色）, `bg`, `count`（きらきらの数）, `speed` |
| `stripes` | 斜めの帯がゆっくり流れる | `color`, `bg`, `size`（帯の周期px）, `angle`（傾き、度）, `speed` |
| `truchet` | タイルの曲線がつながり、少しずつ組み変わる | `color`, `bg`, `size`（タイルの一辺px）, `speed` |
| `waves` | 半透明の波が重なってゆらぐ | `color`, `bg`, `layers`（層の数）, `speed` |

例: `wallpaper/contour/?color=ffd166&bg=transparent&levels=20&speed=0.5`

### OBSでの設定

1. ソースの追加 > ブラウザ
2. URLにギャラリーでコピーしたURLを貼り、幅 1920・高さ 1080 にする

## 時計（`clock/`）

配信画面に重ねて使う時計です。時刻は配信PCのローカル時刻を表示します。背景は既定で透過です。
ギャラリー（`clock/`）で時計を選び、パラメータを調整して、表示されたURLをOBSにコピーします。

```
https://stream-assets.<サブドメイン>.workers.dev/clock/<時計ID>/?<パラメータ>=<値>&...
```

- 表示の有無を切り替えるパラメータは `true` / `false` で指定します（`1` や `yes` はエラーになります）
- 文字や文字盤はブラウザソースの幅・高さに収まる最大の大きさで中央に表示されます。大きさはOBS側でソースの幅・高さを変えて調整します

| 時計ID | 内容 | パラメータ |
| --- | --- | --- |
| `analog` | 現在時刻を針で表示する | `color`（針・目盛り・数字・縁の色）, `accent`（秒針の色）, `face`（文字盤の色、`transparent` で文字盤なし）, `bg`, `size`（収まる最大に対する倍率 0.1〜1）, `seconds`（秒針）, `smooth`（秒針をなめらかに動かす）, `numbers`（1〜12の数字） |
| `digital` | 現在時刻を数字で表示する | `color`（文字の色）, `outline`（縁取りの色、`transparent` で縁取りなし）, `bg`, `size`（収まる最大に対する倍率 0.1〜1）, `seconds`（秒）, `date`（日付）, `weekday`（曜日）, `hour12`（12時間制） |

例: `clock/digital/?color=ffd166&seconds=false&hour12=true`、`clock/analog/?accent=ffd166&smooth=false&numbers=false`

### OBSでの設定

1. ソースの追加 > ブラウザ
2. URLにギャラリーでコピーしたURLを貼り、幅 600・高さ 240 など時計を置きたい大きさにする

## チャットボックス（`chat/`）

Twitchのチャット欄を配信画面に重ねます。背景は透過です。
ギャラリー（`chat/`）でチャンネル名を入れ、パラメータを調整して、表示されたURLをOBSにコピーします。ギャラリーのプレビューは常にサンプルの書き込みです。

```
https://stream-assets.<サブドメイン>.workers.dev/chat/<デザインID>/?channel=<チャンネル名>&<パラメータ>=<値>&...
```

- Twitchへは匿名（読み取り専用）で接続するため、ログインやトークンは不要です。`channel`（`twitch.tv/` の後ろの部分）だけ指定します
- `channel` も `demo=true` もないURLはエラーを表示します（黙ってサンプル表示にはしません）
- モデレーターによる削除・タイムアウト・BAN・`/clear` は、表示中の書き込みにも反映されます
- 回線やTwitch側の都合で切断された場合は、間隔を延ばしながら自動で再接続し、切断と復帰をチャット欄に1行で知らせます
- バッジは配信者・モデレーター・VIP・サブスクライバーを自前のアイコンで表示します（公式のバッジ画像は認証付きAPIが必要なため使いません）
- 7TV・BTTV・FFZ のエモートは各サービスの公開APIから取得します。取得できなかったサービスがあればチャット欄に1行で知らせ、チャットの表示は続けます
- サブスクやレイドなどのお知らせ（USERNOTICE）は表示しません

全デザイン共通のパラメータ: `channel`, `demo`（サンプルの書き込みを流す）, `max`（同時に表示する件数 1〜50）, `lifetime`（消すまでの秒数、0 で消さない）, `badges`, `thirdparty`（7TV・BTTV・FFZ のエモート）

| デザインID | 内容 | パラメータ |
| --- | --- | --- |
| `bubble` | 名前色の名札が付いた、角の丸いふきだし | `size`（文字の大きさ px）, `panel`（ふきだしの色、`transparent` で透過）, `opacity`（ふきだしの不透明度 0〜1）, `text`（文字の色） |
| `card` | 左端に名前色のラインが入った、半透明の落ち着いたカード | `size`（文字の大きさ px）, `panel`（カードの色、`transparent` で透過）, `opacity`（カードの不透明度 0〜1）, `text`（文字の色） |
| `plain` | 地を塗らず、フチ取りした文字だけを並べる（ゲーム画面に直接重ねる用途向け） | `size`（文字の大きさ px）, `text`（本文の文字の色）, `outline`（本文の文字のフチの色） |
| `sticker` | 太い白フチのシールに、少し傾いた名札を貼ったかわいいデザイン | `size`（文字の大きさ px）, `panel`（シールの色）, `border`（シールのフチの色）, `text`（文字の色） |
| `terminal` | 等幅の文字が並ぶ、黒い端末風のデザイン（ブラウザソース全体を画面として塗る） | `size`（文字の大きさ px）, `panel`（画面の色、`transparent` で透過）, `opacity`（画面の不透明度 0〜1）, `text`（文字の色） |

例: `chat/bubble/?channel=your_channel&size=32&lifetime=60`、配置の調整用に `chat/bubble/?demo=true`

### OBSでの設定

1. ソースの追加 > ブラウザ
2. URLにギャラリーでコピーしたURLを貼り、幅 480・高さ 800 などチャット欄を置きたい大きさにする。書き込みは下から入り、幅に合わせて折り返す

## アラート（`alerts/`）

Twitchのイベントに合わせて、画像・動画・音声と文言を配信画面の中央に表示するオーバーレイです。1件ずつ順番に再生し、再生中に届いたものは待たせます。利用には「デプロイ」の節の Twitchログインの設定が必要です。

```text
https://stream-assets.<サブドメイン>.workers.dev/alerts/?key=<オーバーレイ用キー>
```

| パラメータ | 内容 |
| --- | --- |
| `key` | オーバーレイ用キー（必須）。キーを含むURLは管理画面（`/admin/`）でコピーできる。Twitchのトークンではないので、漏れてもTwitchアカウントには影響しない |
| `demo` | `true` でサンプルのアラートを一定間隔で流す（配置の調整用。Twitchには接続しない） |

どのイベントで何をするか（トリガー）は、配信者が管理画面（`/admin/`）で決めます（「デプロイ」の節の「アラートの設定と素材」を参照）。トリガーは「条件（どのイベントか）」と「動作」からなり、動作には**アラートを出す**（このオーバーレイが再生する）・**チャットに送る**（Workerがbotとして送る）・**アナウンスを送る**（Workerがbotがモデレーターとして色の付いた帯で送る）があります。オーバーレイは通知が届くたびに最新の設定を取得するので、設定を変えてもOBSの再読み込みは不要です。アラートを出す動作を持つトリガーが1件もなければ何も表示しません。

チャットに送る動作とアナウンスを送る動作はオーバーレイには渡らず、TwitchからWorkerへ直接届くWebhookで実行します。そのため**OBSを開いていなくてもチャットのお礼は送られます**（送るには「チャットボット」のページでbotアカウントを接続しておきます）。アナウンスはさらに、botがそのチャンネルのモデレーターにされている必要があります。

キーの誤り・未ログイン・購読の取り消しなど人が直さないと直らない失敗は画面全体にエラーを表示し、切断などの一時的な失敗は左下にお知らせを出してつなぎ直します。

### OBSでの設定

1. ソースの追加 > ブラウザ
2. URLに上のURLを貼り、幅と高さを配信のキャンバスと同じ大きさ（1920×1080 など）にする。背景は透過で、素材は中央に表示される
3. 動画・音声の素材を使う場合は、ブラウザソースのプロパティで「OBSで音声を制御する」を有効にすると、音量をOBSのミキサーで調整できる

## 開発

```bash
npm install
npm run dev         # 開発サーバー（Workerも一緒に動く。http://localhost:5173/）
npm run lint        # Lint（警告ゼロ必須）
npm run type-check  # 型チェック
npm test            # テスト
npm run build       # dist/ へビルド（静的アセットは dist/client/、Workerとデプロイ用の設定は dist/stream_assets/）
npm run preview:worker  # ビルドして、Workersと同じ配信挙動をローカルで確認（wrangler dev）
```

### 壁紙の背景を追加する

1. `src/wallpaper/<id>.ts` に `defineBackground` で背景（パラメータのスキーマと描画関数）を定義する
2. `src/wallpaper/registry.ts` に登録する
3. 既存の `wallpaper/aurora/index.html` を `wallpaper/<id>/index.html` に複製し、`data-background` と `<title>` を `<id>` に変える

2と3の対応は `src/wallpaper/registry.test.ts` が検証します。ギャラリーの調整欄はスキーマから自動生成されます。

### 時計を追加する

1. `src/clock/<id>.ts` に `defineBackground` で時計を定義する（現在時刻は描画関数に渡される `frame.now` を使う）
2. `src/clock/registry.ts` に登録する
3. 既存の `clock/digital/index.html` を `clock/<id>/index.html` に複製し、`data-clock` と `<title>` を `<id>` に変える

2と3の対応は `src/clock/registry.test.ts` が検証します。ギャラリーの調整欄はスキーマから自動生成されます。

### チャットボックスのデザインを追加する

チャットボックスは canvas ではなくHTML要素で表示します。メッセージのHTML構造（`src/chat/view.ts`）は全デザイン共通で、デザインごとの違いはCSSで表します。

1. `src/chat/<id>.ts` に `defineChat` でデザインを定義する（スキーマの先頭に `commonChatSchema` を展開し、`cssVariables` でパラメータをCSSのカスタムプロパティに変換する）
2. `src/chat/<id>.css` に見た目を書く（セレクタは `[data-chat='<id>']` から始める）
3. `src/chat/registry.ts` に登録する
4. 既存の `chat/bubble/index.html` を `chat/<id>/index.html` に複製し、`data-chat`・CSSのパス・`<title>` を `<id>` に変える

3と4の対応は `src/chat/registry.test.ts` が検証します。

## デプロイ

Cloudflare Workers で公開します。設定は `wrangler.jsonc` にあり、Viteのビルド出力（`dist/client/`）を静的アセットとして配信し、`/api/*` だけを Worker のコード（`worker/`）で処理します。

### フォークして自分の配信で使う（Deploy to Cloudflare）

下のボタンを押すと、このリポジトリがあなたのGitHubアカウントにフォークされ、Cloudflareが `wrangler.jsonc` を読んでKV（`STORE`）・R2（`MEDIA`）・D1（`DB`）を作り、`.dev.vars.example` にある5つのシークレットの入力を求めたうえで、デプロイまで行います（入力欄に出る説明は `package.json` の `cloudflare.bindings` に書いてあります）。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mtane0412/stream-assets)

押す前に、次の2つを済ませてください。

1. **R2を有効にする** — Cloudflareダッシュボードの Storage & databases > R2 で一度チェックアウトします。無料枠（保存10GB・転送無料）だけを使う場合でも支払い方法の登録を求められますが、無料枠内なら請求は発生しません
2. **Twitchのアプリを登録する** — [Twitch開発者コンソール](https://dev.twitch.tv/console/apps)でアプリを作り、クライアントIDとクライアントシークレットを控えます。OAuthのリダイレクトURLは公開先のドメインが決まってからでよいので、ここでは仮の値（`http://localhost:5173/api/auth/callback` など）で構いません。あわせて配信者のTwitchユーザーID（数字）を調べます（[Twitch CLI](https://dev.twitch.tv/docs/cli/) なら `twitch api get users -q login=<ログイン名>`）

ボタンを押したあとは、次の順で仕上げます。

1. 画面の案内に従ってリソースを作り、5つのシークレット（`TWITCH_CLIENT_ID`・`TWITCH_CLIENT_SECRET`・`TWITCH_BROADCASTER_ID`・`SESSION_SECRET`・`EVENTSUB_SECRET`）を入力してデプロイする
2. 公開されたURL（`https://stream-assets.<サブドメイン>.workers.dev/`）を控え、Twitch開発者コンソールのアプリのOAuthのリダイレクトURLを `https://<控えたドメイン>/api/auth/callback` に変える
3. 公開されたURLを開き、「Twitchでログイン」から配信者のアカウントでログインする。`TWITCH_BROADCASTER_ID` と異なるアカウントは拒否されます。このログインで、配信の記録のためのWebhook宛ての購読も揃います
4. `/admin/` で素材をアップロードしてトリガーを決め、OBS用のURLをコピーする

以降は、フォークしたリポジトリの `main` へpushするたびに Workers Builds がビルドとデプロイを行います。

### 自分でリポジトリを接続する場合

ボタンを使わずに接続することもできます。初回だけ次の設定が必要です。

1. Cloudflareダッシュボードの Workers & Pages で「Import a repository」を選び、このリポジトリを接続する
2. ビルドコマンドに `npm run build`、デプロイコマンドに `npm run deploy` を指定する（`npm run deploy` はデプロイに続けて、配信の記録（後述）のテーブルのマイグレーションも適用します）
3. `.dev.vars.example` にある5つのシークレットを、`npx wrangler secret put <名前>` かダッシュボードの Settings > Variables and Secrets で設定する
4. 公開されたURL（`https://stream-assets.<サブドメイン>.workers.dev/`）を開いて表示を確認する

手元から直接デプロイする場合は、`npx wrangler login` のあとに `npm run build && npm run deploy` を実行します（`npm run deploy` 自体はビルドを行いません。Workers Builds とDeployボタンがビルドを別に実行するため、二重にビルドしないようにしてあります）。

`.github/workflows/ci.yml` はLint・型チェック・テスト・ビルドと `wrangler deploy --dry-run` による設定の検証だけを行い、デプロイはしません。

### Twitchログイン（`/api/*`）の設定

チャンネルポイントなどのイベントを受け取るには配信者のTwitchトークンが必要です。Worker がTwitchログインを受け持ち、トークンを Cloudflare KV（`STORE`）に保管します。トークンはブラウザにもOBSのURLにも出しません。アラートの素材は Cloudflare R2（`MEDIA`）に置きます。KVの名前空間とR2のバケットは、デプロイ時に wrangler が自動で作成します。

R2は無料枠（保存10GB・転送無料）だけを使う場合でも、デプロイの前に一度、Cloudflareダッシュボードの Storage & databases > R2 でR2を有効にする必要があります（支払い方法の登録を求められますが、無料枠内なら請求は発生しません）。

1. [Twitch開発者コンソール](https://dev.twitch.tv/console/apps)でアプリを登録し、OAuthのリダイレクトURLに `https://<公開先のドメイン>/api/auth/callback` を指定する（ローカルで試す場合は `http://localhost:5173/api/auth/callback`（`npm run dev`）と `http://localhost:8787/api/auth/callback`（`npm run preview:worker`）も追加する）
2. `.dev.vars.example` にある5つのシークレット（`TWITCH_CLIENT_ID`・`TWITCH_CLIENT_SECRET`・`TWITCH_BROADCASTER_ID`・`SESSION_SECRET`・`EVENTSUB_SECRET`）を、`npx wrangler secret put <名前>` またはダッシュボードの Settings > Variables and Secrets で設定する。ローカルでは `.dev.vars.example` を `.dev.vars` にコピーして値を入れ、`npm run dev` で起動する
3. `https://<公開先のドメイン>/` を開き、「Twitchでログイン」から配信者のアカウントでログインする。`TWITCH_BROADCASTER_ID` と異なるアカウントは拒否される。ログインを終えるとトップ（ダッシュボード）に戻る

| API | 役割 |
|---|---|
| `GET /api/auth/login` | Twitchの認可ページへ送る。`?role=bot` を付けるとチャットボット用のスコープで送る（配信者のセッションが必要） |
| `GET /api/auth/callback` | トークンを保管し、オーバーレイ用キーを発行（発行済みなら維持）し、配信の記録のためのWebhook宛ての購読を揃えて、セッションを開始し、トップ（`/`。ダッシュボード）へ送る |
| `POST /api/auth/logout` | セッションを終える |
| `GET /api/me` | ログイン中の配信者とオーバーレイ用キーを返す（要セッション） |
| `POST /api/eventsub/subscriptions` | 本文 `{ "key": オーバーレイ用キー, "sessionId": EventSubのWebSocketのセッションID }` を受け取り、保管しているトークンで購読（チャンネルポイント交換・フォロー・サブスク・レイド）を登録する |
| `POST /api/eventsub/webhook` | Twitchから届くEventSubの通知を受け、イベントの件数と配信の開始・終了を記録する（Twitchの署名を `EVENTSUB_SECRET` で確かめる） |

| `GET /api/overlay/config?key=` | オーバーレイ向けに、素材のURL付きのトリガーの一覧を返す（要オーバーレイ用キー） |
| `GET /api/media/<素材ID>?key=` | 素材の中身を返す（要オーバーレイ用キー、または配信者のセッション） |
| `GET`・`PUT /api/admin/config` | アラートの設定の取得・保存（要セッション） |
| `GET`・`POST /api/admin/media` | 素材の一覧・アップロード（要セッション） |
| `DELETE /api/admin/media/<素材ID>` | 素材の削除。トリガーに使われている素材は409で拒否する（要セッション） |
| `POST /api/admin/overlay-key` | オーバーレイ用キーの再発行。古いキーを含むURLは使えなくなる（要セッション） |
| `GET /api/admin/bot` | チャットボットの接続状態（ログイン名・ユーザーID・不足しているスコープ・モデレーターかどうか）。トークンは返さない（要セッション） |
| `DELETE /api/admin/bot` | チャットボットの切断（Workerが持つトークンを消す。要セッション） |
| `POST /api/admin/bot/messages` | 本文 `{ "message": 送る文言 }` を受け取り、botの名前で配信チャンネルのチャットへ送る（要セッション） |
| `POST /api/admin/bot/device-code` | 別の端末で接続するためのコードを発行する（デバイスコードフロー。要セッション） |
| `POST /api/admin/bot/device-token` | 本文 `{ "deviceCode": 発行されたコード }` を受け取り、トークンに交換する。まだ認可されていなければ `{ "status": "pending" }` を返す（要セッション） |
| `GET`・`PUT /api/admin/bot/commands` | チャットのコマンドの取得・保存（要セッション） |
| `GET`・`PUT /api/admin/bot/moderation` | チャットの自動モデレーションの設定の取得・保存（要セッション） |
| `GET /api/admin/rewards` | 配信者のチャンネルポイント報酬の一覧（ID・名前・必要ポイント）。管理画面でトリガーの報酬を選ぶのに使う（要セッション） |
| `GET /api/admin/stats/sessions` | 配信セッションの一覧（新しい順に100件まで）。平均・最大視聴者数、フォロワー増減、イベントの種類ごとの件数つき（要セッション） |
| `GET /api/admin/stats/sessions/<配信ID>` | 配信セッションと、視聴者数の時系列（要セッション） |
| `GET /api/admin/stats/followers` | フォロワー数の時系列。値が変わった時点だけが並ぶ（要セッション） |
| `GET /api/admin/stats/failures` | 記録の収集の失敗の一覧（新しい順に50件まで。要セッション） |

失敗は `{ "error": { "code", "message" } }` の形で返します。受け取るイベントを増やす場合は `worker/eventsub.ts` の `EVENT_TYPES` に足します（スコープが増えたら配信者の再ログインが必要です）。

### アラートの設定と素材

管理画面（`https://<公開先のドメイン>/admin/`）で、配信者としてログインして行います。

| 欄 | できること |
|---|---|
| OBS用のURL | オーバーレイ用キーを含むURLのコピー（配信画面に映り込んでも読めないよう伏せ字で表示する）と、キーの再発行。再発行すると今のURLは使えなくなる |
| 素材 | 画像・動画・音声のアップロード（1ファイル50MBまで）、試し見・試し聴き、削除。トリガーに使われている素材は削除できない |
| トリガー | 「イベント（＋チャンネルポイント交換なら報酬）」と、そのとき行う動作を並べて保存する。動作は「アラートを出す」（素材・表示時間・音量・文言）と「チャットに送る」（文言）で、片方だけでも両方でもよい。複数のトリガーが当てはまるイベントには、上にあるトリガーを使う |

管理用API（`/api/admin/*`）は配信者のセッションが必要で、書き換えを伴うメソッドは管理画面と同じサイトからのリクエスト（`Origin` ヘッダーが一致するもの）だけを受け付けます。ローカルでは `npm run dev`（`http://localhost:5173/admin/`）で確かめます。`@cloudflare/vite-plugin` が開発サーバーの中でWorkerを動かします。

アラートを出す動作は `durationSeconds` が1〜60、`volume` は0〜1、`message` は200文字以内（差し込み語が置き換わり、空文字なら文言を出さない）です。チャットに送る動作の `message` は1〜500文字（Twitchのチャット1通の上限）で、空文字は許しません。同じ種類の動作は1つのトリガーに1件までです。差し込み語はイベント種別ごとに違い、`{user}`（交換した人・フォローした人・レイド元の配信者）のほか、`{reward}`・`{tier}`・`{months}`・`{viewers}` が使えます。設定に問題があれば、保存せずに問題点の一覧（`error.problems`）を返します。

### チャットボット（`/bot/`）

チャットへの書き込みを、配信者とは別のTwitchアカウント（botアカウント）の名前で行えます。Twitchは現在、チャットの読み書きにIRCではなく EventSub と Helix API を使うことを推奨しており、どちらも常時接続を必要としないため Worker だけで動きます。

配信者のアカウントとは**別に**、botアカウントのトークンをKVに保管します（キーは `twitch-token:bot`）。botの接続は配信者のセッションがある人しか開始・完了できません。

接続には2つの道があり、管理画面（`https://<公開先のドメイン>/bot/`）のボタンで選べます。どちらを使う場合も、先に botに使うTwitchアカウントを用意し、配信者としてこのアプリにログインしておきます（配信者と同じアカウントをbotにしても動きますが、チャット欄での見分けがつくよう別アカウントを勧めます）。

#### 別の端末で接続する（おすすめ）

「別の端末で接続する」を押すと8文字のコードが出ます。**botアカウントでログイン済みの端末**（スマホなど）で `https://www.twitch.tv/activate` を開き、そのコードを入力してください。認可が済むと管理画面が自動で切り替わります。

このアプリのログイン（配信者）とTwitchのログイン（bot）が別の端末に分かれるため、**どちらのログインも切り替えずに済みます**。コードの有効期限は30分です。

#### 同じブラウザで接続する

端末が1つしかない場合は、「botアカウントを接続する」を使います。ただし**順序が重要**です。

1. 配信者としてこのアプリにログインした状態にしておく（このアプリのセッションは7日間有効で、次の手順でTwitchのログインを変えても消えません）
2. **twitch.tv だけ**ログアウトし、botアカウントでログインする
3. このアプリの `/bot/` に戻り、「botアカウントを接続する」を押す
4. 接続後、twitch.tv を配信者アカウントに戻す

> **シークレットウィンドウは使えません。** このアプリのログインはこのWorkerのドメインのクッキー（`__Host-session`）で、Twitchのログインは `twitch.tv` のクッキーです。シークレットウィンドウには前者がないため、`/bot/` を開けず、接続も401で拒否されます。

#### 接続したあと

1. 同じ画面の「テスト送信」で、チャットへ実際に送れることを確かめる
2. **Twitchのチャットから配信者が `/mod <botのログイン名>` を実行し、botにモデレーター権限を与える**。アナウンスなどのモデレーション操作は、権限がないとTwitchに拒否されます。権限がなければ `/bot/` の「接続しているアカウント」に案内が出ます

botに要求するスコープは `user:bot`・`user:read:chat`・`user:write:chat` と、モデレーション操作のための `moderator:manage:banned_users`・`moderator:manage:chat_messages`・`moderator:manage:announcements`（`worker/eventsub.ts` の `BOT_SCOPES`）です。配信者側には `channel:bot` と、botがモデレーターかどうかを確かめるための `moderation:read` が要ります。

> **すでに動かしている場合は、botの接続し直しと配信者のログインし直しの両方が必要です。** botのスコープに `moderator:manage:*` が、配信者のスコープに `moderation:read` が増えたためです。足りないスコープは `/bot/` の画面に出ます。

チャットの送信には上限があり、1チャンネルにつき1秒あたり1メッセージ、30秒あたり20メッセージ（botが配信者・モデレーター・VIPのいずれかなら100メッセージ）です。本文は500文字までで、空文字や長すぎる本文はTwitchへ問い合わせる前にWorkerが拒否します。

#### チャットへの応答

botを接続すると、チャットの発言（EventSubの `channel.chat.message`）を Webhook で受け取り、コマンドに応答します。この購読は条件に「チャットを読む人」としてbotのユーザーIDが要るため、**botを接続・切断したタイミングで購読を揃え直します**（botが未接続のときは購読しません）。

コマンドは管理画面（`/bot/`）の「コマンド」の欄で登録します。**登録するまでは何にも応答しません**（組み込みのコマンドはありません）。

| 欄 | 内容 |
|---|---|
| コマンド名 | `!` を除いた名前。チャットでは「!名前」と打ちます。大文字小文字は区別しません |
| 応答文 | 送り返す文言。`{user}` が発言した人のログイン名に置き換わります。500文字まで |
| クールダウン（秒） | この秒数のあいだは、続けて打たれても応答しません。0 なら毎回応答します |

クールダウンは**チャンネル全体**で数えます（視聴者ごとではありません）。連打されたときにTwitchの送信上限に当たらないようにするためです。

- bot自身の発言には応答しません（応答するとbotがbotに応答し続けて止まらなくなります）
- チャットは配信の記録（D1）には書きません。件数の桁が違い、D1の書き込みの枠（Freeで1日10万行）を配信の記録と食い合うためです
- 応答の送信に失敗した場合も、Twitchへは2xxを返して収集の失敗として記録します。2xx以外を返すとTwitchが同じ通知を再送し、送信が成功していた場合に二重投稿になるためです。失敗は管理画面の記録（`/api/admin/stats/failures`）で確認できます
- Twitchが同じ通知を再送しても、二度は応答しません（応答したメッセージIDを1時間だけD1に持ちます）
- D1に書くのは**コマンドに一致した発言のときだけ**です。チャットの全件は記録しません

#### 自動モデレーション

管理画面（`/bot/`）の「自動モデレーション」の欄で、**配信者が自分で決めたルール**に当てはまる発言を、botが自動で処分できます（Twitch自身のAutoModとは別のしくみです）。**既定は無効**で、画面で明示的に有効にするまで何も処分しません。誤って視聴者を処分すると取り返しがつかないためです。

| 欄 | 内容 |
|---|---|
| 種類 | `URLを含む`（URLを含む発言）・`禁止語を含む`（大文字小文字を区別しない部分一致）・`同じ文面の連投`（決めた秒数のあいだの同じ文面の回数） |
| 処分 | `発言を削除`・`タイムアウト`（1〜604800秒）・`BAN`。タイムアウトとBANでは、発言を削除してからユーザーを処分します |
| 対象外 | 配信者とモデレーター・VIP・サブスクライバー（創設者を含む）を、それぞれ処分の対象外にできます。既定はすべて対象外です |

処分には、botのスコープ `moderator:manage:banned_users`・`moderator:manage:chat_messages` と、**botがそのチャンネルのモデレーターにされていること**の両方が要ります。

- 「配信者とモデレーターを対象外にする」は切らないことをおすすめします。Twitchはモデレーターへの処分を受け付けないため、失敗が積み上がるだけになります
- 複数のルールに当たった発言には、**重い処分**（BAN > タイムアウト（長いほう）> 削除）を与えます
- 処分した発言には、コマンドの応答をしません。bot自身の発言は決して処分しません
- 連投の判定に使う直近の文面（ハッシュのみ）をD1に書くのは、**連投のルールが有効なときだけ**です。窓より古い行は判定のたびに消します
- すでにBAN済み・タイムアウト中（Twitchの409）は失敗にせず、処分済みとして扱います。それ以外の失敗は収集の失敗（`moderation-failed`）として記録し、Twitchへは2xxを返します

### 配信の記録

Twitchには過去の視聴者数の推移を返すAPIがないため、Worker が cron（`wrangler.jsonc` の `triggers.crons`。5分おき）でいまの値を取得し、Cloudflare D1（`DB`）に貯めます。グラフにできるのは、記録を始めた時点より後の分だけです。D1のデータベースも、KV・R2と同じくデプロイ時に wrangler が自動で作成します（名前は `stream-assets-db`）。

テーブルの定義は `migrations/` にあり、デプロイとは別に適用します。データベースは最初のデプロイで作られるので、順番は「デプロイ → マイグレーション」です。

```bash
npx wrangler d1 migrations apply DB --remote  # 本番（npm run deploy はこれも行う）
npx wrangler d1 migrations apply DB --local   # ローカル（npm run dev の前に一度）
```

| テーブル | 内容 |
|---|---|
| `stream_sessions` | 配信セッション（Twitchの配信ID・開始と終了の日時・タイトル・カテゴリ）。配信中は `ended_at` が `NULL` |
| `viewer_samples` | 配信中の視聴者数（5分おき） |
| `follower_samples` | フォロワー数。前回から変わったときだけ1行足す |
| `stream_events` | サブスク・ポイント交換・レイドなどのイベントの1件ごとの記録（EventSubのWebhookで受ける。`id` はメッセージIDで、再送を二重に数えない）。配信外のイベントは `session_id` が `NULL` |
| `collection_failures` | 収集の失敗（30日分） |

1回の収集は、Helix の `GET /streams` で配信中かどうかを調べ、配信中ならセッションを開始（続いていれば更新）して視聴者数を1行足し、配信していなければ開いているセッションを閉じます。続けて `GET /channels/followers` の `total` を記録します。セッションの終了時刻は「配信していないことを最初に確かめた時刻」なので、最大5分遅れます。

配信者がログインしていない・トークンを更新できない・Twitchが失敗を返したときは、黙って飛ばさずに `collection_failures` へ記録し、cron の実行も失敗にします。記録が止まっていたら `GET /api/admin/stats/failures` か、Cloudflareダッシュボードの Worker の Settings > Trigger Events で確かめ、`relogin-required` ならログインし直してください。

保持期間は設けていません。書き込みは1日あたり最大で「視聴者数288行＋フォロワー数288行＋セッションの更新」程度で、D1の無料枠（1日10万行の書き込み・保存5GB）に対して十分小さいためです。

#### イベントの件数と、配信の開始・終了（Webhook）

アラート用オーバーレイはブラウザのWebSocketでイベントを受け取るので、オーバーレイを開いていない間のイベントは数えられません。そこで配信の記録のためには、TwitchからWorkerへ直接届くWebhook宛ての購読を別に用意し、`POST /api/eventsub/webhook` で受けます。

- 対象は `channel.subscribe`・`channel.subscription.message`・`channel.channel_points_custom_reward_redemption.add`・`channel.raid`（`stream_events` に1件ずつ記録）と、`stream.online`・`stream.offline`（セッションの開始・終了を cron より正確に記録）、そして `channel.follow`。フォローは数えません（フォロワー数の推移として cron が記録しているため）が、アラートのトリガーの「チャットに送る」動作のために受け取ります
- 届いた通知は、記録に加えてアラートのトリガーにかけます。当てはまるトリガーが「チャットに送る」「アナウンスを送る」動作を持っていれば、botとしてチャットへ1通送ります（botが未接続なら何もしません）。同じ通知が再送されても二度は送らず、送信に失敗した場合もTwitchへは2xxを返して `collection_failures` に `alert-chat-failed`・`alert-announce-failed` として記録します（2xx以外だとTwitchが再送し、送信できていた場合に二重投稿になるため）
- 購読は、配信者がログインしたとき（`GET /api/auth/callback`）に揃えます。Webhook宛ての購読はユーザートークンでは作れないので、アプリアクセストークンを発行し、`https://<公開先のドメイン>/api/eventsub/webhook` 宛てに有効な購読がないイベントだけを登録します。失効した購読は消してから登録し直します。**初めてデプロイしたあとは、一度ログインし直してください**。既に動かしている場合も、`channel.follow` の購読が増えたので一度ログインし直してください（スコープは変わらないので、認可し直す必要はありません）
- 購読の登録にTwitchが失敗を返しても、ログインは止めません（ログインできないと失敗の記録を読めなくなるため）。失敗は `collection_failures` に `webhook-subscription-failed` として記録します。購読が失効したという通知（`revocation`）も `subscription-revoked` として記録するので、`GET /api/admin/stats/failures` に出ていたらログインし直してください
- 受け口は誰でも呼べるURLなので、署名（`Twitch-Eventsub-Message-Signature`。`EVENTSUB_SECRET` によるHMAC-SHA256）を確かめ、10分より古い通知と、購読していない種類の通知は拒否します
- `EVENTSUB_SECRET` は `openssl rand -hex 32` で作ります（Twitchの決まりで10〜100文字のASCII）。あとから変えると、登録済みの購読の通知は署名が合わず403になります。変えたときは `twitch api delete eventsub/subscriptions -q id=<購読ID>`（Twitch CLI）などで購読を消してからログインし直してください
- `stream.online` の通知にはタイトルとカテゴリが無いので、セッションは空のタイトルで始まり、次の cron（5分以内）が埋めます。`stream.offline` の直後に Helix がまだ「配信中」と答えた場合は、cron がセッションを開き直し、次の回で閉じ直すので、その配信の終了時刻は最大5分遅れます

Twitchは `https` のURLしかWebhookの宛先として受け付けないので、ローカル（`http://localhost`）ではログインしても購読を登録しません。受け口の動きは [Twitch CLI](https://dev.twitch.tv/docs/cli/) で確かめます。Twitch CLI は IPv4 でしか接続しないので、開発サーバーを `127.0.0.1` で待ち受けさせ（既定の `localhost` は IPv6 だけになることがあります）、`.dev.vars` の `EVENTSUB_SECRET` と同じ値を `-s` に渡します。

```bash
npm run dev -- --host 127.0.0.1
# 購読の確認（challenge）に応答できるか
twitch event verify-subscription channel.raid -F http://127.0.0.1:5173/api/eventsub/webhook -s <EVENTSUB_SECRET>
# 通知を送る（streamup → channel.raid・channel.subscribe・add-redemption → streamdown の順に送ると、配信中のイベントとして記録される）
twitch event trigger streamup -F http://127.0.0.1:5173/api/eventsub/webhook -s <EVENTSUB_SECRET>
twitch event trigger channel.raid -F http://127.0.0.1:5173/api/eventsub/webhook -s <EVENTSUB_SECRET>
twitch event trigger streamdown -F http://127.0.0.1:5173/api/eventsub/webhook -s <EVENTSUB_SECRET>
npx wrangler d1 execute DB --local --command "SELECT * FROM stream_events"
```

#### ローカルで収集を試す

ローカルで収集を試すには、`npm run dev` を起動した状態で `curl http://localhost:5173/cdn-cgi/handler/scheduled` を実行し、`npx wrangler d1 execute DB --local --command "SELECT * FROM follower_samples"` で中身を確かめます。
