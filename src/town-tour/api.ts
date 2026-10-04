/**
 * 市町村紹介の読み出し（オーバーレイ用API と同梱の日本地図）
 *
 * 合成ページ（overlay/stage/index.html）はOBSに載せるページなのでログインを持たず、オーバーレイ用キー（URLの ?key=）で
 * Worker に受け付けてもらう。呼び出し（市町村と冒頭の一文）は WebSocket（TOWN_TOUR_SOCKET_PATH）で押し出してもらい、
 * 受け取ってから紹介を作らせる（1件2〜5秒。日本地図からズームする演出のあいだに待つ）。
 * 日本地図は Worker ではなく静的なファイル（public/town-tour/japan.topo.json）なので、キーを付けずに読む。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 紹介を作れなかった（502）ときは Worker の理由ごと投げる。黙って何も流さないと、配信者は壊れていることに気付けない。
 */
import { createCaller } from '../core/api'
import { readTownTourIntro, type TownTourIntro } from './tour'

const PATH = '/api/overlay/town-tour'

/** 呼び出しを押し出してもらう WebSocket のパス */
export const TOWN_TOUR_SOCKET_PATH = '/api/overlay/town-tour/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
export const TOWN_TOUR_SOCKET_HINT = '市町村紹介の配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

/** 同梱の日本地図（N03 から作った TopoJSON。scripts/town-tour/build-data.ts の生成物） */
export const JAPAN_MAP_PATH = '/town-tour/japan.topo.json'

export interface TownTourApi {
  /**
   * コードの市町村の紹介を作らせる。
   *
   * @throws ApiError 紹介を作れなかった（502）・一覧に無いコード（404）など。Worker の理由を持つ
   */
  introduce(code: string): Promise<TownTourIntro>
  /** 同梱の日本地図を読む。形の確かめは topo.ts の decodeTownShapes が行う */
  japanMap(): Promise<unknown>
}

/**
 * 市町村紹介の読み出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー（プレビューでは紹介を作らせないので使わない）
 */
export const createTownTourApi = (fetchImpl: typeof fetch, key: string): TownTourApi => {
  const call = createCaller(fetchImpl)

  return {
    introduce: async (code) => readTownTourIntro(await call(`${PATH}?key=${encodeURIComponent(key)}&code=${encodeURIComponent(code)}`)),
    japanMap: () => call(JAPAN_MAP_PATH),
  }
}
