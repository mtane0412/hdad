# stream-assets

Twitch配信用の各種素材を置くリポジトリです。GitHub Pagesで公開し、OBSのブラウザソースからURLで読み込みます。

トップページ（`index.html`）は素材の種類一覧です。素材はカテゴリごとにディレクトリを分けて置きます。

| パス | 内容 |
| --- | --- |
| `wallpaper/` | 配信画面の背景（壁紙）。ギャラリーと各背景のページ |
| `clock/` | 配信画面に重ねる時計。ギャラリーと各時計のページ |
| `chat/` | Twitchのチャット欄を配信画面に重ねるチャットボックス。ギャラリーと各デザインのページ |

## 壁紙（`wallpaper/`）

ギャラリー（`wallpaper/`）で背景を選び、パラメータを調整して、表示されたURLをOBSにコピーします。

```
https://<ユーザー名>.github.io/stream-assets/wallpaper/<背景ID>/?<パラメータ>=<値>&...
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
https://<ユーザー名>.github.io/stream-assets/clock/<時計ID>/?<パラメータ>=<値>&...
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
https://<ユーザー名>.github.io/stream-assets/chat/<デザインID>/?channel=<チャンネル名>&<パラメータ>=<値>&...
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

## 開発

```bash
npm install
npm run dev         # 開発サーバー
npm run lint        # Lint（警告ゼロ必須）
npm run type-check  # 型チェック
npm test            # テスト
npm run build       # dist/ へビルド
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

`main` へのpushで `.github/workflows/deploy.yml` がLint・型チェック・テスト・ビルドを行い、GitHub Pagesへ公開します。
リポジトリの Settings > Pages > Source を「GitHub Actions」に設定してください。
