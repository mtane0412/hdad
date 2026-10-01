/**
 * タブの映像のページ（/tab/）が使うWorkerの呼び出し
 *
 * 映さないサイトの一覧（worker/tab-blocked-hosts.ts）を読み、消す。登録は拡張のボタンの右クリックから行う
 * （いま開いているタブのホスト名をそのまま入れ、手で打たせない）ので、ここには登録の呼び出しを持たない。
 *
 * 注意: 応答の形が違えばエラーにする（Fail-Fast）。黙って空の一覧にすると、登録が消えたように見えてしまう。
 */
import { createCaller } from '../core/api'
import { BLOCKED_HOSTS_PATH, parseBlockedHosts } from './blocked-hosts'

export interface TabApi {
  /** 映さないサイトの一覧を読む */
  loadBlockedHosts(): Promise<string[]>
  /**
   * ホスト名を一覧から消す。
   *
   * @returns 消したあとの一覧
   */
  removeBlockedHost(host: string): Promise<string[]>
}

export const createTabApi = (fetchImpl: typeof fetch): TabApi => {
  const call = createCaller(fetchImpl)
  return {
    loadBlockedHosts: async () => parseBlockedHosts(await call(BLOCKED_HOSTS_PATH)),
    removeBlockedHost: async (host) => parseBlockedHosts(await call(`${BLOCKED_HOSTS_PATH}/${encodeURIComponent(host)}`, { method: 'DELETE' })),
  }
}
