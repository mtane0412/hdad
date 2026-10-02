---
paths:
  - "src/tab/**"
  - "extension/**"
  - "worker/tab-*.ts"
---

# タブの映像（コネクターの HDAD-tab・素材の種類 `tab`・`extension/`）

タブの映像は、Chrome のタブ1枚の映像と音を配信画面へ出す素材（素材の種類 `tab`）である。**取り込みと送信は拡張（`extension/`）の offscreen document が受け持つ**（`extension/src/capture-session.ts`。拡張はコネクターのページ（`/connectors/`）の HDAD-tab の区画（`src/tab/tab-section.tsx`）が配って案内するだけで、開いておく必要はない）。映像と音は拡張から合成ページへ WebRTC で同じPCの中を直接流れ、Worker を通るのはつなぐための連絡（`src/tab/signal.ts`）だけである。→ `docs/decisions/tab.md`

**ボタン（ショートカット）の手順は `extension/src/controller.ts` だけが持つ**。押されたタブを映し、**映しているタブでもう一度押されたら止め**、別のタブなら切り替える。映しているタブは `chrome.storage.session` に覚える（サービスワーカーは眠ると変数を失う。権限 `storage` が要る。拡張の API は権限が無いと例外を投げずに undefined になるので、権限は `extension/src/manifest.test.ts` で確かめる）。**押下と offscreen document からの知らせは `createSerialQueue` で1つずつ順に処理する**（並ぶと、記録する前の押下や知らせが「映していない」と判断する）。IDは `getMediaStreamId({ targetTabId })` で取り込む側を指定せずに取り、同じ拡張の offscreen document で使う。**IDは数秒で使えなくなるので、受け取ったらすぐ取り込む**。取れない・取り込めない・中継先につながらないときは**黙らずにバッジ「!」と説明で知らせる**。

**サービスワーカーと offscreen document は `chrome.runtime.sendMessage` であて先（`target`）を付けてやりとりする**（形は `extension/src/offscreen-command.ts`・`offscreen-event.ts`）。offscreen document は状態が変わるたびに全体（合成ページの数と失敗の知らせ）を送る。**2つの入口から同じモジュールを実行時に読み込まない**（共有のチャンクができると zip に入らない。サービスワーカー側の小さな判定は `extension/src/guards.ts`、offscreen document 側は `src/core/api.ts` の `isRecord` を使う。`extension/vite.config.ts` が決まったファイル以外を出したらビルドを失敗させる。一覧は `extension/src/built-files.ts`）。

**拡張は配信者のセッションで中継先へつなぐ**。拡張にログイン情報や鍵を保存しない。**offscreen document からの WebSocket にはクッキーが付かない**（権限があっても付かないことを実機で確かめた）ので、サービスワーカーが `chrome.cookies` でセッションのクッキー（名前は `extension/src/session-cookie.ts`。Worker の `SESSION_COOKIE` との一致は `worker/tab-routes.test.ts` が確かめる）を読み、**WebSocket のプロトコルの欄で `[SENDER_PROTOCOL, セッション]` として渡す**（`src/tab/signal.ts`。URL に載せない。Worker の記録に7日間使える値が残るため）。Worker（`worker/tab-routes.ts`）はそれを確かめ、`SENDER_PROTOCOL` だけを応え返す。クッキーを読むのに要る `host_permissions` は、ダウンロードのときに Worker が manifest.json へ書き込む。Worker は `Origin` が `chrome-extension://<固定のID>` のときだけ送り手として受け入れる（IDは manifest.json の `key` で固定し、`extension/src/identity.ts` に持つ。一致は `identity.test.ts` が確かめる）。

**連絡の中継（`worker/tab-channel.ts` の `TabChannel`）は中身を読まず、両方向に配る**。送り手から届いたものは合成ページ全員へ、合成ページから届いたものは送り手へだけ配り、**合成ページどうしには配らない**（オーバーレイ用キーは配信画面に映りうるため）。送り手として受け入れるのはセッションで守られた経路（`worker/tab-routes.ts`）だけで、WebSocket は GET なので `Origin` を自分で確かめる。合成ページ側の入口は `worker/overlay-routes.ts` の `overlayTabSocket`。

**接続は合成ページごとに1本**（合成ページは開くたびに `viewerId` を作って名乗る）。いつ名乗り・どの offer に応じ・いつ作り直すかは `src/tab/sender.ts`・`src/tab/receiver.ts` だけが持ち、`RTCPeerConnection` は `src/tab/peer.ts` に閉じ込める（ふるまいは接続を偽物に差し替えてテストする）。ICE は集め終えてから SDP にまとめて送る（trickle ICE の連絡を持たない）。

**映像は H.264 を優先し、送れないブラウザでは VP8 へ黙って切り替えずに失敗させる**（`preferH264`。負荷と遅延が大きく変わるため）。**接続が failed になったら送り手が作り直す**（閉じて名乗り直しを頼む）。

**取り込みには上限と一緒に下限（`minWidth`・`minHeight`）も渡す**（`src/tab/capture.ts`）。上限だけだと Chrome は大きさを固定して縦横比の違う分を黒い帯で埋め、合成ページでは透明にできないため。

**タブを閉じた・映すのをやめた・接続が切れたときは、エラーにせず透明に戻す**（配信中に普通に起こる操作のため。状態は拡張のボタンにだけ出す）。合成ページの箱に失敗を出すのは、中継先につながらないときと再生できないときだけである。

**映さないサイト（issue #165）の判定は `extension/src/controller.ts` の `handleNavigation` だけが持ち、照合とホスト名の形の判定は `src/tab/blocked-hosts.ts` だけが持つ**（Worker の検証と拡張が共有する。拡張のサービスワーカーが読み込むので、ほかのファイルを読み込まない）。登録はホスト名の完全一致だけで、正規表現もパスも持ち込まない。**映さないサイトへは移り始め（`webNavigation.onBeforeNavigate`）で止め、送り直すのは映してよい URL を `tabs.onUpdated` で知ったときだけにする**（移り始めでは前のページがまだ映っている）。止めるのは取り込みを保ったままの `pause`（合成ページとの接続を閉じて `stop` を送る）で、**止められなければ取り込みごと止める**。**一覧は映し始めるたびに Worker（KV の `tab-blocked-hosts`。`worker/tab-blocked-hosts.ts`）から読み、読めなければ映し始めない**（安全側）。拡張は `chrome.cookies` で読んだセッションを `Authorization: Bearer` で渡す（`worker/tab-routes.ts` の `requireExtensionOrAdmin`）。**登録・解除は拡張だけで行う**（一覧を管理する場所を1か所にし、拡張が覚えている一覧と食い違わせない。コネクターのページの HDAD-tab の区画は仕方を案内するだけ）。右クリック（`contextMenus`。`handleSiteMenuClick`）は開いているタブのサイトを登録し、登録済みなら外す。項目の名前は前に出ているタブが変わるたびに覚えている一覧から決め直し（`refreshSiteMenu`）、押したときもその同じ一覧で登録か解除かを決める。拡張の設定ページ（`options_ui`。`extension/src/options-page.ts`）は一覧を見て、ホスト名を入力して登録し、消す。設定ページは Worker を直接呼ばず、サービスワーカーへ頼む（`extension/src/settings-request.ts`・`handleSettingsRequest`）。一覧が変わったら映しているタブにもすぐ反映する（`applyBlockedHosts`）。読んだ一覧と映しているあいだの記録（`CaptureState`）は `chrome.storage.session` に置く。

**映す範囲（issue #166）は拡張で選び、送り手が持つ**（Worker にも URL にも置かない）。右クリック「映す範囲を選ぶ」（`handlePickAreaClick`）で映しているタブにだけ `extension/src/area-picker.ts` の `pickArea` を `chrome.scripting.executeScript` で差し込み（権限 `scripting`・`activeTab`）、決まった範囲は `chrome.runtime.sendMessage` で届く（`handleAreaPicked`。どのタブかは `sender.tab` から取る）。**`pickArea` は文字列にしてタブへ送られるので、関数の外の値を参照しない**（`area-picker.test.ts` が関数の文字列から動かして確かめる）。範囲は表示領域に対する割合で、形の検証は `src/tab/crop.ts` の `parseTabCrop` だけが持つ（サービスワーカーは同じファイルを読み込めないので、`parseAreaPicked` は4つの数であることだけを見る）。送り手（`src/tab/sender.ts`）は名乗った合成ページへ offer の前に `crop` を送り、変わったら全員へすぐ送る。**範囲は1つだけで、別のタブを映し始めたら外す**（`capture-session.ts`。送るのを止めて送り直すときは外さない）。合成ページは canvas に描き直さず、外枠（`.tab-clip`）の中で `<video>` を拡大してずらす（置き方は `layoutCrop`。範囲が全部見えるように収め、余白は透明）。

**拡張は配信者がアプリ（`/connectors/` の HDAD-tab）からダウンロードする**。`GET /api/admin/tab/extension.zip`（`worker/tab-extension.ts`）が、ビルド済みの拡張（`ASSETS` の `/tab-extension/`）に、リクエストの置き場所を書いた `config.json` を加え、manifest.json へその置き場所の `host_permissions` を書き足して zip にする。**`offscreen.html` は静的アセットにせず Worker が書く**（静的アセットは `.html` で終わるURLを拡張子なしへ 307 で転送するので ASSETS から読めない。中身は `extension/src/built-files.ts`）（置き場所をビルドに埋め込まない。公開先のアドレスはビルドの時点では分からないため）。ファイルが欠けていれば欠けた zip を返さずに失敗させる。拡張のビルド（`npm run build:extension`）は `predev`・`prebuild` で本体の前に走り、`public/tab-extension/` に出す。型チェックは `tsconfig.extension.json`（`npm run type-check` に含まれる）。

利用者向けの説明は `docs/guide/tab.md`。
