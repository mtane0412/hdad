/**
 * サイドスーパーの読み出し（オーバーレイ用API の呼び出し）
 *
 * オーバーレイ（side-super/index.html）は素材ページなのでログインを持たず、アラートのオーバーレイと同じ
 * オーバーレイ用キー（URLの ?key=）で Worker に受け付けてもらう。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 文言は cron が5分おきに作って Worker に貯めてあるものなので、こちらは定期的に読みに行くだけでよい
 * （アラートのように押し出してもらう必要がない）。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義して形を確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って空の一覧にすると、Workerの作りが変わって
 * 文言が届かなくなっても、配信中は「まだ作られていない」と見分けが付かない。
 */
import { createCaller, readList } from '../core/api'

const PATH = '/api/overlay/side-super'

export interface SideSuperApi {
  /**
   * いま出す行を読む。
   *
   * @returns 表示する行。配信していない・まだ作っていなければ空の一覧
   */
  read(): Promise<string[]>
}

/**
 * サイドスーパーの読み出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createSideSuperApi = (fetchImpl: typeof fetch, key: string): SideSuperApi => {
  const call = createCaller(fetchImpl)
  const path = `${PATH}?key=${encodeURIComponent(key)}`

  return {
    async read() {
      const body = await call(path)
      return readList(body, 'lines', (value): value is string => typeof value === 'string')
    },
  }
}
