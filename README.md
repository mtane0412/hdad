# stream-assets

Twitch配信用の各種素材を置くリポジトリです。Cloudflare Workers の静的アセットとして公開し、OBSのブラウザソースからURLで読み込みます。

トップページ（`index.html`）は配信者のTwitchログインを前提にしたダッシュボードです（`npm run dev` では `/api/*` が動かないので、`npm run preview:worker` で確かめます）。OBSに載せる素材ページはログインなしで動きます。素材はカテゴリごとにディレクトリを分けて置きます。

| パス | 内容 |
| --- | --- |
| `wallpaper/` | 配信画面の背景（壁紙）。ギャラリーと各背景のページ |
| `clock/` | 配信画面に重ねる時計。ギャラリーと各時計のページ |
| `chat/` | Twitchのチャット欄を配信画面に重ねるチャットボックス。ギャラリーと各デザインのページ |
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

どの報酬でどの素材を出すか（トリガー）は、配信者が管理画面（`/admin/`）で決めます（「デプロイ」の節の「アラートの設定と素材」を参照）。オーバーレイは通知が届くたびに最新の設定を取得するので、設定を変えてもOBSの再読み込みは不要です。トリガーが1件もなければ何も表示しません。

キーの誤り・未ログイン・購読の取り消しなど人が直さないと直らない失敗は画面全体にエラーを表示し、切断などの一時的な失敗は左下にお知らせを出してつなぎ直します。

### OBSでの設定

1. ソースの追加 > ブラウザ
2. URLに上のURLを貼り、幅と高さを配信のキャンバスと同じ大きさ（1920×1080 など）にする。背景は透過で、素材は中央に表示される
3. 動画・音声の素材を使う場合は、ブラウザソースのプロパティで「OBSで音声を制御する」を有効にすると、音量をOBSのミキサーで調整できる

## 開発

```bash
npm install
npm run dev         # 開発サーバー
npm run lint        # Lint（警告ゼロ必須）
npm run type-check  # 型チェック
npm test            # テスト
npm run build       # dist/ へビルド
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

Cloudflare Workers で公開します。設定は `wrangler.jsonc` にあり、Viteのビルド出力（`dist/`）を静的アセットとして配信し、`/api/*` だけを Worker のコード（`worker/`）で処理します。

`main` へのpushを受けて、Cloudflareの Workers Builds がビルドとデプロイを行います。初回だけ次の設定が必要です。

1. Cloudflareダッシュボードの Workers & Pages で「Import a repository」を選び、このリポジトリを接続する
2. ビルドコマンドに `npm run build`、デプロイコマンドに `npx wrangler deploy` を指定する
3. 公開されたURL（`https://stream-assets.<サブドメイン>.workers.dev/`）を開いて表示を確認する

手元から直接デプロイする場合は、`npx wrangler login` のあとに `npm run deploy` を実行します。

`.github/workflows/ci.yml` はLint・型チェック・テスト・ビルドと `wrangler deploy --dry-run` による設定の検証だけを行い、デプロイはしません。

### Twitchログイン（`/api/*`）の設定

チャンネルポイントなどのイベントを受け取るには配信者のTwitchトークンが必要です。Worker がTwitchログインを受け持ち、トークンを Cloudflare KV（`STORE`）に保管します。トークンはブラウザにもOBSのURLにも出しません。アラートの素材は Cloudflare R2（`MEDIA`）に置きます。KVの名前空間とR2のバケットは、デプロイ時に wrangler が自動で作成します。

R2は無料枠（保存10GB・転送無料）だけを使う場合でも、デプロイの前に一度、Cloudflareダッシュボードの Storage & databases > R2 でR2を有効にする必要があります（支払い方法の登録を求められますが、無料枠内なら請求は発生しません）。

1. [Twitch開発者コンソール](https://dev.twitch.tv/console/apps)でアプリを登録し、OAuthのリダイレクトURLに `https://<公開先のドメイン>/api/auth/callback` を指定する（ローカルで試す場合は `http://localhost:8787/api/auth/callback` も追加する）
2. `.dev.vars.example` にある4つのシークレット（`TWITCH_CLIENT_ID`・`TWITCH_CLIENT_SECRET`・`TWITCH_BROADCASTER_ID`・`SESSION_SECRET`）を、`npx wrangler secret put <名前>` またはダッシュボードの Settings > Variables and Secrets で設定する。ローカルでは `.dev.vars.example` を `.dev.vars` にコピーして値を入れ、`npm run preview:worker` で起動する
3. `https://<公開先のドメイン>/admin/` を開き、「Twitchでログイン」から配信者のアカウントでログインする。`TWITCH_BROADCASTER_ID` と異なるアカウントは拒否される。ログインを終えると管理画面に戻る

| API | 役割 |
|---|---|
| `GET /api/auth/login` | Twitchの認可ページへ送る |
| `GET /api/auth/callback` | トークンを保管し、オーバーレイ用キーを発行（発行済みなら維持）して、セッションを開始し、管理画面（`/admin/`）へ送る |
| `POST /api/auth/logout` | セッションを終える |
| `GET /api/me` | ログイン中の配信者とオーバーレイ用キーを返す（要セッション） |
| `POST /api/eventsub/subscriptions` | 本文 `{ "key": オーバーレイ用キー, "sessionId": EventSubのWebSocketのセッションID }` を受け取り、保管しているトークンで購読（チャンネルポイント交換・フォロー・サブスク・レイド）を登録する |

| `GET /api/overlay/config?key=` | オーバーレイ向けに、素材のURL付きのトリガーの一覧を返す（要オーバーレイ用キー） |
| `GET /api/media/<素材ID>?key=` | 素材の中身を返す（要オーバーレイ用キー、または配信者のセッション） |
| `GET`・`PUT /api/admin/config` | アラートの設定の取得・保存（要セッション） |
| `GET`・`POST /api/admin/media` | 素材の一覧・アップロード（要セッション） |
| `DELETE /api/admin/media/<素材ID>` | 素材の削除。トリガーに使われている素材は409で拒否する（要セッション） |
| `POST /api/admin/overlay-key` | オーバーレイ用キーの再発行。古いキーを含むURLは使えなくなる（要セッション） |
| `GET /api/admin/rewards` | 配信者のチャンネルポイント報酬の一覧（ID・名前・必要ポイント）。管理画面でトリガーの報酬を選ぶのに使う（要セッション） |

失敗は `{ "error": { "code", "message" } }` の形で返します。受け取るイベントを増やす場合は `worker/eventsub.ts` の `EVENT_TYPES` に足します（スコープが増えたら配信者の再ログインが必要です）。

### アラートの設定と素材

管理画面（`https://<公開先のドメイン>/admin/`）で、配信者としてログインして行います。

| 欄 | できること |
|---|---|
| OBS用のURL | オーバーレイ用キーを含むURLのコピー（配信画面に映り込んでも読めないよう伏せ字で表示する）と、キーの再発行。再発行すると今のURLは使えなくなる |
| 素材 | 画像・動画・音声のアップロード（1ファイル50MBまで）、試し見・試し聴き、削除。トリガーに使われている素材は削除できない |
| トリガー | 報酬（Twitchから取得した一覧、または「すべての報酬」）・素材・表示時間・音量・文言の組を並べて保存する。複数が当てはまる交換には、上にあるトリガーを使う |

管理用API（`/api/admin/*`）は配信者のセッションが必要で、書き換えを伴うメソッドは管理画面と同じサイトからのリクエスト（`Origin` ヘッダーが一致するもの）だけを受け付けます。管理画面は `/api/*` を呼び出すので、ローカルでは `npm run dev` ではなく `npm run preview:worker`（`http://localhost:8787/admin/`）で確かめます。

`durationSeconds` は1〜60、`volume` は0〜1、`message` は200文字以内（`{user}` と `{reward}` が置き換わり、空文字なら文言を出さない）です。設定に問題があれば、保存せずに問題点の一覧（`error.problems`）を返します。
