# 素材を重ねる合成ページ（`overlay/stage/`）

素材を重ねる合成ページ（`overlay/stage/index.html`）は、OBSのブラウザソースの数を減らすための1枚である（issue #101・#103）。実ファイルを `/overlay/stage/` に置くのは、`/overlay/` を構成の管理画面に使うためである（`/side-super/`・`/focus/` と同じ分け方）。

ブラウザソースはその数だけ Chromium のレンダラを立ち上げるので、素材ごとにページを分けると配信中のメモリを食う。**1枚にはまとめられない**（アバターやゲーム画面というWebでないソースが間に挟まり、Web側の素材をその前と後ろの両方に置きたいため）ので、ブラウザソースの数は素材の数ではなく「**Webでないソースを挟んで何枚に分かれるか**」で決まる。

## 用語はOBSの見方に合わせる

**用語はOBSの見方に合わせている**（issue #103 で、当初の「段（`group`）に置くレイヤー」から改めた）。**オーバーレイ**（`Overlay`。`name` と `items`）がOBSのブラウザソース1つ＝重なりの1枚で、その中に**素材**（`OverlayItem`）を積む。OBSでもブラウザソースの重なりがレイヤーなので、内側の素材をレイヤーと呼ぶと逆立ちする。既定のオーバーレイは背面 `back` と前面 `front` の2つで、配信者が増やせる。

## URLと構成の持ち方

OBSに貼るURLは `?key=`（オーバーレイ用キー）と `?overlay=`（描くオーバーレイの名前）だけで、**名前を固定しておけばURLは一度貼ったら変わらない**ので、「時計を背面から前面へ移す」も「位置を変える」もアプリ上の編集だけで済む（読み上げの設定をURLからWorkerへ移した issue #86 と同じ動機である）。

構成は `worker/overlay-layout.ts`（KVのキーは `overlay-layout`。検証は `speech-config.ts`・`focus-config.ts` と同じ作りで、問題点をすべて集めてから拒む）が持ち、経路は `GET`/`PUT /api/admin/overlay/layout`（`requireAdmin`）と `GET /api/overlay/layout`（`requireOverlayKey`）である。

1素材は種類（`kind`。壁紙・時計・チャット・アラート・サイドスーパー・注目コメント）・デザインID（`id`。壁紙・時計・チャットだけが持ち、それ以外は空文字）・パラメータ（`params`）・オーバーレイの中での位置と大きさ（`rect`）を持つ。

**入れ子（オーバーレイが素材を持つ）にしてあるので、「素材を1つも持たないオーバーレイ」は拒める**（貼っても何も映らないURLを作らせない。平らな配列＋`group` の列で持っていたころは表せなかった）。

**パラメータはクエリ文字列のまま持ち、中身はWorkerが検証しない**（解析は `src/core/params.ts` の `parseParams` で、それはページ側にある＝`worker/` から `src/` を読み込まない約束の裏返しである。デザインIDも同じ理由でレジストリと照らし合わせず書式だけを見る）。**位置と大きさは割合（％）で持つ**（配信解像度が変わっても崩れないため）。

ページ側は構成の読み出し（`src/overlay/api.ts`）・オーバーレイの絞り込みと箱の位置（`layout.ts`）・ポーリングの束ね方（`poll.ts`）を分けてテストし、DOMとWebSocketは `stage.ts` が受け持つ（素材ページの約束どおりReactもログインも持たない）。

## まとめて得たものを次の3つで守る

- 素材ごとに canvas を1枚持ち、1枚の全画面 canvas へ合成しない（小さく置いた時計が全画面ぶんの描画面積を持ってしまう）
- `requestAnimationFrame` はオーバーレイで1本にし、そのループで各素材の描画を順に呼ぶ（素材ごとに張ると本数が元に戻る）
- 同じオーバーレイの素材は接続を共有する（匿名IRCは1本、チャンネル名・公式バッジ・Cheermote の取得も1回、ポーリングは1つのタイマー。`stage.ts` の `createChatHub` と `poll.ts` の `pollTickMs`・`dueTasks`。刻みはいちばん短い間隔＝注目コメントの10秒で、サイドスーパーは3回に1回読む）

## 1つの素材の失敗をほかへ広げない

**1つの素材の失敗で、同じオーバーレイのほかの素材は動かし続ける**（Fail-Fast に意識して設けた例外である）。理由は「配信中に片方が壊れたときの被害を、配信画面の全損から1素材の欠落に留めるため」で、失敗はその素材の箱の中だけに出す。描画中に投げた素材は一覧から外して同じ失敗を毎フレーム出さない。

そのため `src/core/mount.ts` は窓（`window.innerWidth`）ではなく**canvas 自身のCSS上の大きさ**（`ResizeObserver`）を基準にし、「1フレームぶんの描画」を返す `startCanvasLayer` の形にしてある（**壁紙12種と時計2種のレジストリには手を入れていない**。描画関数は `width`・`height` を引数で受け取るためである）。当初は素材ごとのページ向けにループまで回す `mountStage` をその上に置いていたが、単独ページを消したときに一緒に消した（後述）。

`showError` は出す箱と**失敗の出どころ**（`ErrorSource`。`layer`／`read`／`chat`）を受け取り、`.stage-error` も `position: absolute` にして箱を基準にする。出どころを添えるのは、1つの箱に別々の理由の表示が同時に出うるためで（注目コメントは読み出しとチャットの接続の両方を使う）、`clearError` は**同じ出どころの表示だけ**を消す（読み出しが直っても、読み直しでは直らないチャットの接続の失敗は残す）。

## 素材のCSS

素材のCSSが画面基準で書いていた `position: fixed` はすべて `absolute` に直し（チャット5種・アラート・サイドスーパー）、`focus` の `min-height` も `100svh` から `100%` にした（箱の高さに合わせるため）。重ねうる素材のCSSは `src/overlay/overlay.css` が1枚にまとめて `@import` し、素材1つの箱は `.overlay-item` である。

**デザインが増えたときの取りこぼしは `src/overlay/styles.test.ts` が検出する**（読み込みを忘れると、その素材だけが見た目を失ったまま配信画面に出て、配信中は気付きにくい）。

## 単独ページとギャラリーを消した（issue #107）

合成ページを入れた時点では、**既存の単独ページ（`alerts/`・`side-super/overlay/`・`focus/overlay/` と素材ページ）を残した**（合成ページが実際の配信で安定したことを確かめてから決めるため）。実配信で確かめる条件は「メモリの実際の減り方」「数時間の配信での描画の乱れ・接続の切れ」「1素材の失敗が他に波及しないこと」で、これを満たせたので issue #107 で**すべて消した**。

消したのは次のとおりである。

| 消したもの | 置き換え先 |
| --- | --- |
| `alerts/`・`side-super/overlay/`・`focus/overlay/` と、その入口 `src/alerts/stage.ts`・`src/side-super/stage.ts`・`src/focus/stage.ts` | 素材の種類 `alerts`・`sideSuper`・`focus` |
| 素材ページ `wallpaper/<id>/`・`clock/<id>/`・`chat/<id>/` と、その入口 `src/core/stage.ts`・`src/clock/stage.ts`・`src/chat/stage.ts` | 素材の種類 `wallpaper`・`clock`・`chat` |
| ギャラリー（`/wallpaper/`・`/clock/`・`/chat/`。`src/core/gallery/gallery.tsx`） | `/overlay/` の管理画面 |
| サイドスーパーのページ（`/side-super/`。`src/side-super/side-super-page.tsx`） | `/overlay/` の管理画面 |
| `src/core/mount.ts` の `mountStage`・`MountTarget` | `startCanvasLayer`（合成ページがループを回す） |

**単独オーバーレイ3つだけを消してギャラリーを残す案は採らなかった。** ギャラリーが配っていたOBS用URLは素材ページのURLそのもの（`buildBackgroundUrl`）で、素材ページを消すと配る先が無くなる。一方でデザインの選択・パラメータの調整・プレビュー・URL発行はすべて `/overlay/` の管理画面が持っているので、ギャラリーを「試し見だけのカタログ」として残しても役割が重なるだけである。代わりに合成ページへ「1素材だけを映すモード」（`?item=wallpaper:contour&params=...`）を足す案も、消そうとしている「単独のURL」という仕組みを別の形で残すことになるので採らなかった。**失ったのはレジストリの `description`（デザインの説明文）の見せ場だけである。**

**サイドスーパーのページだけは画面ごと消した。** 中身が単独ページのURLと寄せる向きの選択だけで、向きは素材のパラメータとして `/overlay/` で選べるため、残すと空の画面になる。注目コメント（`/focus/`）とトリガー（`/triggers/`）は取り上げの操作・トリガーの操作という固有の中身を持つので残し、URLのカードだけを `/overlay/` への案内に差し替えた。**オーバーレイ用キーの再発行はトリガーのページに残してある**（キーはすべてのオーバーレイと裏方で共通なので、出し先を1つに保つ）。

共有していた部品は `src/core/gallery/` から `src/core/` へ移した（`fields.tsx`・`preview.tsx`・`url.ts`）。`url.ts` は `serializeParams` だけになり、`GalleryItem` は `src/core/background.ts` の `DesignItem` へ移した。

裏方（`speech/reader/`・`transcript/relay/`）は映すものを持たず置き換え先が無いので、この決定の対象外である（`docs/decisions/backstage.md`）。
