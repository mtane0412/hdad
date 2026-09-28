# 裏方をまとめたページ（`overlay/backstage/`）

**裏方をまとめたページ（`overlay/backstage/`）は、OBSに置くWebのページのうち映すものを持たないもの（チャットの読み上げ・文字起こしの中継）を1つのブラウザソースにまとめる**（issue #108）。

実ファイルを `/overlay/backstage/` に置くのは `/overlay/` を構成の管理画面に使うためで、`vite.config.ts` の `categories` ではなく入力に直接足している。

**合成ページ（`overlay/stage/`）の素材にはしない。**

裏方は映すものを持たないので位置も大きさも持たず、素材にすると構成が持つ `rect` が意味を失う。

読み上げの起動の失敗は配信画面の小さな箱の中に出しても配信者は見ないので、「素材の失敗はその箱の中だけに出す」という約束とも前提が合わない。

また合成ページのブラウザソースは「配信画面に映すもの」なので、同じPCのループバックへしかつなげない裏方を混ぜるとその見方が崩れる（案として「素材の種類にする」と「そのままにする」も比べたうえで、裏方だけの1枚を採った）。

**動かす裏方はURLで指定する**（`?speech=false`・`?transcript=false`。既定は両方。合成ページの `?overlay=<名前>` と同じ「このブラウザソースが何をするか」という構造の指定なので、配信中に変える設定をWorkerへ移した issue #86 とは扱いを分ける）。

ひとつも動かさないURLは組み立てない（`src/backstage/url.ts` の `backstageUrl`。貼っても何もしないブラウザソースを作らせない＝素材を1つも持たないオーバーレイを保存しないのと同じ考え方）。

**1つの裏方の失敗で、もう一方は動かし続ける**（合成ページが素材について設けた例外と同じ。1枚にまとめたせいで片方の失敗がもう一方を巻き込まないため）ので、裏方ごとに箱（`.backstage-task`）を置いて失敗はその中に出す。

そのため `src/transcript/transcript.css` の `.transcript` は `position: fixed` から `absolute` に直してある（素材のCSSを直したのと同じ理由）。

裏方そのものは `src/speech/task.ts` の `startSpeech` と `src/transcript/task.ts` の `startTranscript` にあり、単独ページと同じものを呼ぶ（判定や通信を2か所に書き分けない）。

**単独ページ（`speech/reader/`・`transcript/relay/`）は残してある**（素材の単独ページと同じく、消すかどうかは別に決める）。

アプリのページ（`src/backstage/backstage-page.tsx`）は動かす裏方の選択とゆかコネNEO のポート、それにOBSに貼るURLを受け持ち、URLの組み立ては `url.ts` に分けてテストする（ポートの検証は `src/transcript/url.ts` の `assertTranscriptPort` を共有する。2か所で書き分けると、同じ入力欄に対して片方だけが通るURLを出してしまう）
