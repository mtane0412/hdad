/**
 * 配信者へ渡す Chrome 拡張の zip づくり
 *
 * 拡張（extension/）は、信頼する HDAD の置き場所の /tab/ にだけストリームIDを渡す。置き場所は公開先（workers.dev）の
 * アカウントごとに違い、ビルドの時点では分からないので、ダウンロードのときに Worker が受けたリクエストから置き場所を
 * 取り、それを書いた設定（config.json。形は extension/src/config.ts）を加えて zip にする（issue #168）。
 *
 * 拡張そのもの（manifest.json・background.js）は、本体のビルドの前に npm run build:extension が public/tab-extension/
 * へ出し、静的アセットとして配られている。ここは ASSETS から読むだけにする。
 *
 * 注意: ファイルが1つでも読めなければ、欠けた zip を返さずに失敗させる（読み込めない拡張を配らない。Fail-Fast）。
 */
import { strToU8, zipSync } from 'fflate'
import { CONFIG_FILE, type ExtensionConfig } from '../extension/src/config'
import { HttpError, STATUS, type AssetFetcher } from './http'

/** ビルド済みの拡張が静的アセットとして置かれている場所 */
const ASSET_DIR = '/tab-extension/'
/** zip に入れるビルド済みのファイル（extension/vite.config.ts が出すもの） */
const BUILT_FILES = ['manifest.json', 'background.js'] as const
/** zip を展開したときにできるフォルダの名前。Chrome にはこのフォルダを読み込んでもらう */
export const EXTENSION_FOLDER = 'hdad-tab'

/**
 * ビルド済みのファイルを1つ読む。無ければ失敗させる。
 *
 * 静的アセットは見つからないパスにアプリの index.html を状態コード200で返す（wrangler.jsonc の not_found_handling）ので、
 * 状態コードだけでなく、HTML が返ってきたことも「見つからない」と見なす（拡張のファイルに HTML は無い）。
 */
const readBuiltFile = async (assets: AssetFetcher, base: URL, name: string): Promise<Uint8Array> => {
  const response = await assets.fetch(new Request(new URL(`${ASSET_DIR}${name}`, base)))
  const isHtml = response.headers.get('Content-Type')?.startsWith('text/html') === true
  if (!response.ok || isHtml) {
    throw new HttpError(
      STATUS.internalServerError,
      'tab-extension-missing',
      `ビルド済みの拡張（${ASSET_DIR}${name}）が見つかりません。npm run build（拡張のビルドを含む）でデプロイし直してください`,
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * 拡張の zip を作る。
 *
 * @param origin 信頼する置き場所（ダウンロードを受けたリクエストのオリジン）
 * @throws HttpError ビルド済みのファイルが見つからない場合
 */
export const buildExtensionZip = async (assets: AssetFetcher, origin: string): Promise<Uint8Array> => {
  const base = new URL(origin)
  const config: ExtensionConfig = { trustedOrigins: [origin] }
  const entries: Record<string, Uint8Array> = { [`${EXTENSION_FOLDER}/${CONFIG_FILE}`]: strToU8(`${JSON.stringify(config, null, 2)}\n`) }
  for (const name of BUILT_FILES) entries[`${EXTENSION_FOLDER}/${name}`] = await readBuiltFile(assets, base, name)
  return zipSync(entries)
}
