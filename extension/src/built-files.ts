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

/** zip に入れるビルド済みのファイル（public/ から写すものと、入口ごとの出力） */
export const BUILT_FILES = [MANIFEST_FILE, 'offscreen.html', ENTRY_FILES.background, ENTRY_FILES.offscreen] as const
