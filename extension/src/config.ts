/**
 * 拡張に同梱する設定（config.json）の読み取り
 *
 * 配信者がアプリ（/tab/）から拡張をダウンロードすると、Worker（worker/tab-extension.ts）がそのときの HDAD の置き場所
 * （オリジン）を書いた config.json を拡張に入れて返す。拡張は、ここに書かれた置き場所の /tab/ にだけストリームIDを渡す
 * （パスだけで探すと、別のサイトの /tab/ にIDを渡してしまい、そのサイトが映したいタブの映像と音を取り込めてしまう）。
 *
 * 置き場所をビルドのときに渡さないのは、公開先（workers.dev）のアドレスがアカウントごとに違い、ビルドの時点では
 * 分からないためである。Worker は受けたリクエストから自分の置き場所を正確に知っている（issue #168）。
 *
 * 注意: 読めない設定は、黙って「どこでも信頼する」形に倒さずエラーにする（Fail-Fast）。
 */

/** 拡張の中での設定のファイル名 */
export const CONFIG_FILE = 'config.json'

/** 拡張の設定 */
export interface ExtensionConfig {
  /** 信頼する HDAD の置き場所（https://ドメイン の形のオリジン） */
  readonly trustedOrigins: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** オリジンそのもの（パスや末尾の / を含まない）か */
const isOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

/**
 * config.json の中身を読む。
 *
 * @throws 置き場所の一覧が無い・空・オリジンでないものを含む場合
 */
export const parseExtensionConfig = (value: unknown): ExtensionConfig => {
  if (!isRecord(value) || !Array.isArray(value.trustedOrigins) || value.trustedOrigins.length === 0 || !value.trustedOrigins.every(isOrigin)) {
    throw new Error(`拡張の設定（${CONFIG_FILE}）を読み取れません。HDAD の「タブの映像」のページ（/tab/）から拡張をダウンロードし直してください`)
  }
  return { trustedOrigins: value.trustedOrigins.filter(isOrigin) }
}
