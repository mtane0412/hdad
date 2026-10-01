/**
 * 拡張のビルドが出すファイルの一覧
 *
 * extension/vite.config.ts はこの一覧どおりのファイルだけを出し（それ以外のファイルができたらビルドを失敗させる）、
 * Worker（worker/tab-extension.ts）はこの一覧を ASSETS から読んで zip に詰める。一覧を1か所に置くことで、
 * ビルドが出すものと zip に入るものが食い違わないようにする。
 */

/** manifest.json（Worker が置き場所への権限を書き足す） */
export const MANIFEST_FILE = 'manifest.json'

/** ビルドの入口ごとの出力。サービスワーカー（ボタンを受ける）と offscreen document（取り込んで送る） */
export const ENTRY_FILES = { background: 'background.js', offscreen: 'offscreen.js' } as const

/** zip に入れるビルド済みのファイル（public/ から写す manifest.json と、入口ごとの出力） */
export const BUILT_FILES = [MANIFEST_FILE, ENTRY_FILES.background, ENTRY_FILES.offscreen] as const

/** offscreen document のページのファイル名（background.ts が chrome.offscreen.createDocument で開く） */
export const OFFSCREEN_PAGE_FILE = 'offscreen.html'

/**
 * offscreen document のページ（画面には出ない）。offscreen.js を読み込むだけである。
 *
 * ビルドの出力（静的アセット）にせず、Worker が zip を作るときにこの中身を書く。公開先の静的アセットは
 * .html で終わるURLを拡張子なしのURLへリダイレクト（307）するので、Worker が ASSETS から読めないため。
 */
export const OFFSCREEN_PAGE = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>HDAD タブの映像</title>
    <script type="module" src="${ENTRY_FILES.offscreen}"></script>
  </head>
</html>
`
