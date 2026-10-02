/**
 * 拡張のビルドが出すファイルの一覧
 *
 * extension/vite.config.ts はこの一覧どおりのファイルだけを出し（それ以外のファイルができたらビルドを失敗させる）、
 * Worker（worker/tab-extension.ts）はこの一覧を ASSETS から読んで zip に詰める。一覧を1か所に置くことで、
 * ビルドが出すものと zip に入るものが食い違わないようにする。
 */

/** manifest.json（Worker が置き場所への権限を書き足す） */
export const MANIFEST_FILE = 'manifest.json'

/** ビルドの入口ごとの出力。サービスワーカー（ボタンを受ける）・offscreen document（取り込んで送る）・設定ページ（映さないサイトを管理する） */
export const ENTRY_FILES = { background: 'background.js', offscreen: 'offscreen.js', options: 'options.js' } as const

/** zip に入れるビルド済みのファイル（public/ から写す manifest.json と、入口ごとの出力） */
export const BUILT_FILES = [MANIFEST_FILE, ENTRY_FILES.background, ENTRY_FILES.offscreen, ENTRY_FILES.options] as const

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

/** 設定ページのファイル名（manifest.json の options_ui で指す） */
export const OPTIONS_PAGE_FILE = 'options.html'

/**
 * 設定ページ。映さないサイトの一覧を出し、追加・削除する（中身は options.js が組み立てる）。
 *
 * offscreen.html と同じ理由で、ビルドの出力にせず Worker が zip に書く。
 */
export const OPTIONS_PAGE = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <title>HDAD タブの映像の設定</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
      form { display: flex; gap: 0.5rem; margin: 1rem 0; }
      input { flex: 1; font: inherit; padding: 0.25rem 0.5rem; }
      ul { list-style: none; padding: 0; }
      li { display: flex; justify-content: space-between; align-items: center; border: 1px solid #8884; border-radius: 0.375rem; padding: 0.25rem 0.75rem; margin-bottom: 0.25rem; }
      .host { font-family: ui-monospace, monospace; }
      .failure { color: #d93025; }
    </style>
    <script type="module" src="${ENTRY_FILES.options}"></script>
  </head>
  <body>
    <h1>映さないサイト</h1>
    <p>映しているタブがここにあるサイトへ移ると、合成ページへ送るのを止めます。映してよいページへ移ると再開します。</p>
  </body>
</html>
`

/** Worker が zip に書くページ（ファイル名と中身） */
export const PAGES: Readonly<Record<string, string>> = { [OFFSCREEN_PAGE_FILE]: OFFSCREEN_PAGE, [OPTIONS_PAGE_FILE]: OPTIONS_PAGE }
