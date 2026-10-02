/**
 * 映さないサイトの一覧（タブの映像の保険）
 *
 * 映しているタブがここに登録したホスト名のページへ移ったら、拡張は合成ページへ送るのを止める（issue #165）。
 * 一覧は配信中に増やしたり消したりするのでURLには入れず、ストア（KV）に持つ（docs/principles.md の方針3）。
 * 書き込むのは配信者ひとり（拡張のボタンの右クリックと拡張の設定ページから登録し、消す）なので、KV の反映の遅れは問題にならない。
 *
 * 照合とホスト名の形の判定は src/tab/blocked-hosts.ts にあり、拡張と同じものを使う。
 *
 * 注意: ホスト名でないものは保存せずに拒む。拡張が照合に使うのはブラウザが返すホスト名（小文字・ポートなし）なので、
 * 形の違う登録は一致せず、映してはいけないページを映したまま気づけないため。
 */
import { isHostName } from '../src/tab/blocked-hosts'
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const STORE_KEY = 'tab-blocked-hosts'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '映さないサイト'

/**
 * 保存済みの一覧を読む。未保存なら空の一覧を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
export const loadBlockedHosts = async (store: KeyValueStore): Promise<string[]> => {
  const text = await store.get(STORE_KEY)
  return text === null ? [] : (JSON.parse(text) as string[])
}

const saveBlockedHosts = (store: KeyValueStore, hosts: readonly string[]): Promise<void> => store.put(STORE_KEY, JSON.stringify(hosts))

/**
 * ホスト名を一覧に加える。登録済みなら何もしない。
 *
 * @returns 加えたあとの一覧
 * @throws ConfigError ホスト名でない場合
 */
export const addBlockedHost = async (store: KeyValueStore, host: unknown): Promise<string[]> => {
  if (!isHostName(host)) {
    throw new ConfigError(SUBJECT, ['host: ホスト名（例: mail.google.com）だけを、小文字で、ポートやパスを付けずに指定してください'])
  }
  const hosts = await loadBlockedHosts(store)
  if (hosts.includes(host)) return hosts
  const next = [...hosts, host]
  await saveBlockedHosts(store, next)
  return next
}

/**
 * ホスト名を一覧から外す。登録されていなければ何もしない（消す操作を繰り返してもエラーにしない）。
 *
 * @returns 外したあとの一覧
 */
export const removeBlockedHost = async (store: KeyValueStore, host: string): Promise<string[]> => {
  const hosts = await loadBlockedHosts(store)
  if (!hosts.includes(host)) return hosts
  const next = hosts.filter((entry) => entry !== host)
  await saveBlockedHosts(store, next)
  return next
}
