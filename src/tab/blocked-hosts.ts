/**
 * 映さないサイトの照合（拡張・Worker・アプリの /tab/ で共有する）
 *
 * タブを映していると、そのタブの中でメール・管理画面・銀行など映してはいけないページへ移ってしまうことがある。
 * その保険として、配信者が登録したホスト名のページでは拡張が送るのを止める（issue #165）。
 *
 * 登録の単位はホスト名の完全一致だけにする。正規表現は持ち込まない（検証と ReDoS の対策が要るため。
 * docs/principles.md の方針1）。登録は拡張のボタンの右クリックから、いま開いているタブのホスト名をそのまま入れる
 * （手で打たせない。方針2）ので、パスの前方一致は持たない。
 *
 * 注意: 拡張のサービスワーカーから読み込むので、ほかのファイルを読み込まない（offscreen document と同じモジュールを
 * 読み込むと、ビルドで共有のファイルができて zip に入らない。extension/vite.config.ts）。
 */

/** 一覧を読み書きする Worker の経路（拡張と /tab/ が呼ぶ） */
export const BLOCKED_HOSTS_PATH = '/api/admin/tab/blocked-hosts'

/** 一覧の対象にするページの種類。chrome:// などはホスト名で見分けられないので対象外にする */
const WEB_PROTOCOLS: readonly string[] = ['http:', 'https:']

/**
 * ホスト名そのもの（小文字で、ポート・パス・ログイン名を含まない）か。
 *
 * URL として読み直したホスト名が元の文字列と同じになるかで確かめる（ブラウザが返すホスト名と同じ形だけを受け付ける）。
 */
export const isHostName = (value: unknown): value is string => {
  if (typeof value !== 'string' || value === '') return false
  try {
    return new URL(`https://${value}`).hostname === value
  } catch {
    return false
  }
}

/**
 * ページのURLから、登録に使うホスト名を取る。
 *
 * @returns http・https のページでなければ（chrome:// など）、または読めなければ null
 */
export const hostOfPageUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    return WEB_PROTOCOLS.includes(parsed.protocol) ? parsed.hostname : null
  } catch {
    return null
  }
}

/**
 * このURLのページを映してはいけないか。
 *
 * 注意: 読めないURLは、映してよいと分からないので映さない側に倒す。http・https 以外のページ（chrome:// など）は
 * ホスト名で登録できないので、一覧の対象外として映す。
 */
export const isBlockedUrl = (url: string, hosts: readonly string[]): boolean => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  if (!WEB_PROTOCOLS.includes(parsed.protocol)) return false
  return hosts.includes(parsed.hostname)
}

/**
 * Worker の応答（{ hosts: string[] }）から一覧を読む。
 *
 * @throws 形が違う場合。黙って空の一覧にすると、映してはいけないページを映してしまうため
 */
export const parseBlockedHosts = (body: unknown): string[] => {
  const hosts: unknown = typeof body === 'object' && body !== null && 'hosts' in body ? body.hosts : undefined
  if (!Array.isArray(hosts) || !hosts.every(isHostName)) throw new Error('映さないサイトの一覧の形が想定と違います')
  return hosts
}
