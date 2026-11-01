/**
 * 映さないサイトの照合（拡張と Worker で共有する）
 *
 * タブを映していると、そのタブの中でメール・管理画面・銀行など映してはいけないページへ移ってしまうことがある。
 * その保険として、配信者が登録したホスト名のページでは拡張が送るのを止める（issue #165）。
 *
 * 登録の単位はホスト名の完全一致だけにする。正規表現もパスの前方一致も持ち込まない（検証と ReDoS の対策が要るため。
 * docs/principles.md の方針1）。登録は拡張のボタンの右クリック（いま開いているタブのホスト名）と、拡張の設定ページでの入力で行う。
 *
 * 注意: 拡張のサービスワーカーから読み込むので、ほかのファイルを読み込まない（offscreen document と同じモジュールを
 * 読み込むと、ビルドで共有のファイルができて zip に入らない。extension/vite.config.ts）。
 */

/** 一覧を読み書きする Worker の経路（拡張のサービスワーカーが呼ぶ） */
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

/**
 * 同時視聴の対象のホスト（issue #443）。映像と音を送らず、再生位置だけを送る。
 *
 * 作品のページは /gp/video/detail/ から /dp/ へ移り、/dp/ は商品のページと同じパスなので、パスでは分けない。
 * 映しているタブの移動はこのホストの単位で止め（移り始めには題名が分からないため）、押されたタブは classifyWatchPartyPage が題名でも分ける。
 * extension/public/manifest.json の host_permissions と一致させる（extension/src/manifest.test.ts）。
 */
export const WATCH_PARTY_HOSTS: readonly string[] = ['www.amazon.co.jp', 'www.primevideo.com']

/** このページで映像と音を送らず、同時視聴にするか */
export const isWatchPartyUrl = (url: string): boolean => {
  const host = hostOfPageUrl(url)
  return host !== null && WATCH_PARTY_HOSTS.includes(host)
}

/** 題名によらず Prime Video だけを配るホスト */
const PRIME_VIDEO_ONLY_HOST = 'www.primevideo.com'
/** Prime Video のページの題名に含まれる語（実機で作品のページと一覧のページの題名に含まれていた） */
const PRIME_VIDEO_TITLE = 'Prime Video'
/** chrome.tabs の、読み込みが終わった状態 */
const TAB_COMPLETE = 'complete'

/** 押されたタブの扱い。watch は同時視聴、other は映像として映す、unknown は判定できない */
export type WatchPartyPage = 'watch' | 'other' | 'unknown'

/**
 * 押されたタブを同時視聴にするかを決める。
 *
 * 注意: 読み込み中の題名は前のページや URL のことがあるので、題名に Prime Video が無くても映してよいとはしない
 * （作品のページで映像と音を送ってしまうため）。呼び出し側は unknown なら何も始めない。
 */
export const classifyWatchPartyPage = (page: { readonly url: string; readonly title?: string; readonly status?: string }): WatchPartyPage => {
  if (!isWatchPartyUrl(page.url)) return 'other'
  if (hostOfPageUrl(page.url) === PRIME_VIDEO_ONLY_HOST || page.title?.includes(PRIME_VIDEO_TITLE) === true) return 'watch'
  return page.title !== undefined && page.status === TAB_COMPLETE ? 'other' : 'unknown'
}
