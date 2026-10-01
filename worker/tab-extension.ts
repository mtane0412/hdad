/**
 * 配信者へ渡す Chrome 拡張の zip づくり
 *
 * 拡張（extension/）は、タブを取り込んで HDAD の中継先へ配信者のセッションでつなぐ。置き場所は公開先（workers.dev）の
 * アカウントごとに違い、ビルドの時点では分からないので、ダウンロードのときに Worker が受けたリクエストから置き場所を
 * 取り、次の2つを書き込んで zip にする（issue #168）。
 *
 * - 設定（config.json。形は extension/src/config.ts）: つなぐ先の置き場所
 * - manifest.json の host_permissions: その置き場所への権限。権限があると、拡張からのWebSocketに配信者のクッキー
 *   （SameSite=Lax）が付く。権限が無いと別サイトからの接続と同じ扱いになり、クッキーが付かない
 *
 * 拡張そのもの（manifest.json・background.js・offscreen.js）は、本体のビルドの前に npm run build:extension が
 * public/tab-extension/ へ出し、静的アセットとして配られている。ここは ASSETS から読むだけにする。
 * offscreen document のページ（offscreen.html）だけは、ここで中身を書く（静的アセットは .html で終わるURLを
 * 拡張子なしのURLへリダイレクトするので、ASSETS から読めないため。中身は extension/src/built-files.ts）。
 *
 * 注意: ファイルが1つでも読めなければ、欠けた zip を返さずに失敗させる（読み込めない拡張を配らない。Fail-Fast）。
 */
import { strFromU8, strToU8, zipSync } from 'fflate'
import { CONFIG_FILE, type ExtensionConfig } from '../extension/src/config'
import { BUILT_FILES, MANIFEST_FILE, OFFSCREEN_PAGE, OFFSCREEN_PAGE_FILE } from '../extension/src/built-files'
import { HttpError, STATUS, type AssetFetcher } from './http'

/** ビルド済みの拡張が静的アセットとして置かれている場所 */
const ASSET_DIR = '/tab-extension/'
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * ビルド済みの manifest.json に、置き場所への権限を書き足す。
 *
 * @throws HttpError manifest.json を JSON として読めない場合
 */
const withHostPermission = (manifest: Uint8Array, origin: string): Uint8Array => {
  let value: unknown
  try {
    value = JSON.parse(strFromU8(manifest))
  } catch {
    value = null
  }
  if (!isRecord(value)) {
    throw new HttpError(STATUS.internalServerError, 'tab-extension-missing', `ビルド済みの拡張（${ASSET_DIR}${MANIFEST_FILE}）を読み取れません。npm run build でデプロイし直してください`)
  }
  return strToU8(`${JSON.stringify({ ...value, host_permissions: [`${origin}/*`] }, null, 2)}\n`)
}

/**
 * 拡張の zip を作る。
 *
 * @param origin HDAD の置き場所（ダウンロードを受けたリクエストのオリジン）
 * @throws HttpError ビルド済みのファイルが見つからない場合
 */
export const buildExtensionZip = async (assets: AssetFetcher, origin: string): Promise<Uint8Array> => {
  const base = new URL(origin)
  const config: ExtensionConfig = { origin }
  const entries: Record<string, Uint8Array> = {
    [`${EXTENSION_FOLDER}/${CONFIG_FILE}`]: strToU8(`${JSON.stringify(config, null, 2)}\n`),
    [`${EXTENSION_FOLDER}/${OFFSCREEN_PAGE_FILE}`]: strToU8(OFFSCREEN_PAGE),
  }
  for (const name of BUILT_FILES) {
    const file = await readBuiltFile(assets, base, name)
    entries[`${EXTENSION_FOLDER}/${name}`] = name === MANIFEST_FILE ? withHostPermission(file, origin) : file
  }
  return zipSync(entries)
}
