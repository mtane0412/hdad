/**
 * Chrome 拡張（extension/）のビルド設定
 *
 * サービスワーカー（src/background.ts）・offscreen document（src/offscreen.ts）・設定ページ（src/options.ts）を、それぞれ1つの ES モジュール
 * （background.js・offscreen.js・options.js）にまとめ、public/ の manifest.json と並べて本体の public/tab-extension/ へ出す。
 * offscreen.html と options.html は出さない（静的アセットの .html は Worker から読めないので、Worker が zip に書く。src/built-files.ts）。
 * 本体のビルドがそれを静的アセットとして配り、Worker（GET /api/admin/tab/extension.zip。worker/tab-extension.ts）が読んで、
 * 置き場所を書いた config.json と置き場所への権限を加えた zip にして配信者へ返す。
 *
 * 置き場所はビルドに埋め込まない（公開先のアドレスはアカウントごとに違い、ビルドの時点では分からないため。issue #168）。
 * 本体の npm run dev・npm run build の前に、package.json の predev・prebuild がこのビルドを走らせる。
 *
 * 注意: 2つの入口が同じモジュールを実行時に読み込むと、共有のファイル（チャンク）ができる。Worker は決まったファイル
 * （src/built-files.ts）しか zip に詰めないので、決まったファイル以外ができたらビルドを失敗させる（欠けた拡張を配らない）。
 */
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { ENTRY_FILES } from './src/built-files'

const here = import.meta.dirname

/** 入口ごとの出力以外のファイルができたら、ビルドを失敗させる */
const onlyEntryFiles = (): Plugin => ({
  name: 'hdad-extension-only-entry-files',
  generateBundle(_options, bundle) {
    const expected: readonly string[] = Object.values(ENTRY_FILES)
    const unexpected = Object.keys(bundle).filter((fileName) => !expected.includes(fileName))
    if (unexpected.length > 0) {
      this.error(`拡張のビルドが想定外のファイルを出しました: ${unexpected.join(', ')}。サービスワーカーと offscreen document で同じモジュールを実行時に読み込んでいないか確かめてください`)
    }
  },
})

export default defineConfig({
  root: here,
  publicDir: resolve(here, 'public'),
  plugins: [onlyEntryFiles()],
  build: {
    outDir: resolve(here, '../public/tab-extension'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(here, 'src/background.ts'),
        offscreen: resolve(here, 'src/offscreen.ts'),
        options: resolve(here, 'src/options.ts'),
      },
      output: { format: 'es', entryFileNames: '[name].js' },
    },
  },
})
