/**
 * 市町村紹介の読み出し（オーバーレイ用API と同梱の日本地図）
 *
 * 合成ページ（overlay/stage/index.html）はOBSに載せるページなのでログインを持たず、オーバーレイ用キー（URLの ?key=）で
 * Worker に受け付けてもらう。呼び出し（市町村と冒頭の一文）は WebSocket（TOWN_TOUR_SOCKET_PATH）で押し出してもらい、
 * 受け取ってから紹介を作らせる（1件2〜5秒。日本地図からズームする演出のあいだに待つ）。
 * 冒頭の都道府県当てクイズ（issue #251）を流しはじめたら、出題を開かせる（POST /api/overlay/town-tour/quiz）。
 * 開いてからクイズの長さのあいだ、Worker はチャットの発言を回答として照らし、最初の正解者を同じ WebSocket で押し出す。
 * 紹介を流しきったら、紹介した市町村として記録させる（POST /api/overlay/town-tour/visit。全国制覇マップ。issue #252）。
 * 日本地図は Worker ではなく静的なファイル（public/town-tour/japan.topo.json）なので、キーを付けずに読む。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 紹介を作れなかった（502）ときは Worker の理由ごと投げる。黙って何も流さないと、配信者は壊れていることに気付けない。
 */
import { createCaller } from '../core/api'
import { readTownTourIntro, type TownTourIntro, type TownTourVisit } from './tour'

const PATH = '/api/overlay/town-tour'
const QUIZ_PATH = '/api/overlay/town-tour/quiz'
const VISIT_PATH = '/api/overlay/town-tour/visit'

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
  /**
   * 冒頭のクイズの出題を開かせる。正解の都道府県は Worker がコードから引く。
   *
   * @throws ApiError 一覧に無いコード（404）など。Worker の理由を持つ
   */
  openQuiz(quizId: string, code: string): Promise<void>
  /**
   * 流しきった市町村を、きっかけと相手と一緒に記録させる。
   *
   * @throws ApiError 記録できなかった（502）・一覧に無いコード（404）など。Worker の理由を持つ
   */
  recordVisit(code: string, visit: TownTourVisit): Promise<void>
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
    openQuiz: async (quizId, code) => {
      await call(`${QUIZ_PATH}?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId, code }),
      })
    },
    recordVisit: async (code, { occasion, userName }) => {
      await call(`${VISIT_PATH}?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, occasion, userName }),
      })
    },
    japanMap: () => call(JAPAN_MAP_PATH),
  }
}
