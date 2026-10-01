---
paths:
  - "src/tab/**"
  - "extension/**"
  - "worker/tab-*.ts"
---

# タブの映像（`/tab/`・素材の種類 `tab`・`extension/`）

タブの映像は、Chrome のタブ1枚の映像と音を配信画面へ出す素材（素材の種類 `tab`）である。**取り込みと送信は拡張（`extension/`）の offscreen document が受け持つ**（`extension/src/capture-session.ts`。`/tab/` は拡張を配って案内するだけで、開いておく必要はない）。映像と音は拡張から合成ページへ WebRTC で同じPCの中を直接流れ、Worker を通るのはつなぐための連絡（`src/tab/signal.ts`）だけである。→ `docs/decisions/tab.md`

**ボタン（ショートカット）の手順は `extension/src/controller.ts` だけが持つ**。押されたタブを映し、**映しているタブでもう一度押されたら止め**、別のタブなら切り替える。映しているタブは `chrome.storage.session` に覚える（サービスワーカーは眠ると変数を失う。権限 `storage` が要る。拡張の API は権限が無いと例外を投げずに undefined になるので、権限は `extension/src/manifest.test.ts` で確かめる）。**押下と offscreen document からの知らせは `createSerialQueue` で1つずつ順に処理する**（並ぶと、記録する前の押下や知らせが「映していない」と判断する）。IDは `getMediaStreamId({ targetTabId })` で取り込む側を指定せずに取り、同じ拡張の offscreen document で使う。**IDは数秒で使えなくなるので、受け取ったらすぐ取り込む**。取れない・取り込めない・中継先につながらないときは**黙らずにバッジ「!」と説明で知らせる**。

**サービスワーカーと offscreen document は `chrome.runtime.sendMessage` であて先（`target`）を付けてやりとりする**（形は `extension/src/offscreen-command.ts`・`offscreen-event.ts`）。offscreen document は状態が変わるたびに全体（合成ページの数と失敗の知らせ）を送る。**2つの入口から同じモジュールを実行時に読み込まない**（共有のチャンクができると zip に入らない。サービスワーカー側の小さな判定は `extension/src/guards.ts`、offscreen document 側は `src/core/api.ts` の `isRecord` を使う。`extension/vite.config.ts` が決まったファイル以外を出したらビルドを失敗させる。一覧は `extension/src/built-files.ts`）。

**拡張は配信者のセッション（クッキー）で中継先へつなぐ**。拡張にログイン情報や鍵は持たせない。クッキーが付くのは、ダウンロードのときに Worker が manifest.json へ置き場所の `host_permissions` を書き込むからである。Worker は `Origin` が `chrome-extension://<固定のID>` のときだけ送り手として受け入れる（IDは manifest.json の `key` で固定し、`extension/src/identity.ts` に持つ。一致は `identity.test.ts` が確かめる）。

**連絡の中継（`worker/tab-channel.ts` の `TabChannel`）は中身を読まず、両方向に配る**。送り手から届いたものは合成ページ全員へ、合成ページから届いたものは送り手へだけ配り、**合成ページどうしには配らない**（オーバーレイ用キーは配信画面に映りうるため）。送り手として受け入れるのはセッションで守られた経路（`worker/tab-routes.ts`）だけで、WebSocket は GET なので `Origin` を自分で確かめる。合成ページ側の入口は `worker/overlay-routes.ts` の `overlayTabSocket`。

**接続は合成ページごとに1本**（合成ページは開くたびに `viewerId` を作って名乗る）。いつ名乗り・どの offer に応じ・いつ作り直すかは `src/tab/sender.ts`・`src/tab/receiver.ts` だけが持ち、`RTCPeerConnection` は `src/tab/peer.ts` に閉じ込める（ふるまいは接続を偽物に差し替えてテストする）。ICE は集め終えてから SDP にまとめて送る（trickle ICE の連絡を持たない）。

**映像は H.264 を優先し、送れないブラウザでは VP8 へ黙って切り替えずに失敗させる**（`preferH264`。負荷と遅延が大きく変わるため）。**接続が failed になったら送り手が作り直す**（閉じて名乗り直しを頼む）。

**取り込みには上限と一緒に下限（`minWidth`・`minHeight`）も渡す**（`src/tab/capture.ts`）。上限だけだと Chrome は大きさを固定して縦横比の違う分を黒い帯で埋め、合成ページでは透明にできないため。

**タブを閉じた・映すのをやめた・接続が切れたときは、エラーにせず透明に戻す**（配信中に普通に起こる操作のため。状態は拡張のボタンにだけ出す）。合成ページの箱に失敗を出すのは、中継先につながらないときと再生できないときだけである。

**拡張は配信者がアプリ（`/tab/`）からダウンロードする**。`GET /api/admin/tab/extension.zip`（`worker/tab-extension.ts`）が、ビルド済みの拡張（`ASSETS` の `/tab-extension/`）に、リクエストの置き場所を書いた `config.json` を加え、manifest.json へその置き場所の `host_permissions` を書き足して zip にする。**`offscreen.html` は静的アセットにせず Worker が書く**（静的アセットは `.html` で終わるURLを拡張子なしへ 307 で転送するので ASSETS から読めない。中身は `extension/src/built-files.ts`）（置き場所をビルドに埋め込まない。公開先のアドレスはビルドの時点では分からないため）。ファイルが欠けていれば欠けた zip を返さずに失敗させる。拡張のビルド（`npm run build:extension`）は `predev`・`prebuild` で本体の前に走り、`public/tab-extension/` に出す。型チェックは `tsconfig.extension.json`（`npm run type-check` に含まれる）。

利用者向けの説明は `docs/guide/tab.md`。
