/**
 * 手書きの線の表し方と、届いた文字列の読み取り
 *
 * 描く画面（/draw/）と合成ページ（overlay/stage/index.html）のあいだを流れるのは、この形の文字列だけである。
 * 描く画面がポインタの動きを追い、線の描き始め（start）と続き（extend）を送る。合成ページはそれを受け取って描く。
 *
 * 座標は箱の大きさに対する比（0が左端・上端、1が右端・下端）で持つ。描く画面のキャンバスと、合成ページで
 * この素材に割り当てられた箱は大きさが違うため、生のピクセルで送ると載せた箱の大きさによって図が歪む。
 *
 * 注意: 想定した形でなければエラーにする。黙って捨てると、線が出ない原因に気付けない。
 */

/** 箱の大きさに対する比で表した1点 */
export interface Point {
  readonly x: number
  readonly y: number
}

/** 線を描き始めた。id はこの線を指す名前で、続き（extend）はこの名前で同じ線に足していく */
export interface StrokeStart {
  readonly type: 'start'
  readonly id: string
  readonly point: Point
}

/** 描いている線に点を足す。ポインタの動きは細かいので、何点かをまとめて送る */
export interface StrokeExtend {
  readonly type: 'extend'
  readonly id: string
  readonly points: readonly Point[]
}

/** 描く画面から合成ページへ流れる1通 */
export type DrawMessage = StrokeStart | StrokeExtend

/**
 * 線の名前の長さの上限。
 *
 * 描く画面が付ける短い識別子なので、これを超えるものが届いたら送り手の作りを疑う
 * （貯める側の大きさが送り手次第で際限なく膨らまないようにする意味もある）。
 */
const MAX_ID_LENGTH = 64

/**
 * 1通で送れる点の数の上限。
 *
 * 描く画面はフレームごとにまとめて送るので、1通が数点から数十点になる。これを大きく超えるものは
 * 想定した送り方ではない。
 */
export const MAX_POINTS_PER_MESSAGE = 256

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 座標として使える数か。はみ出した値（0未満・1より大きい）は、ポインタを箱の外へ動かせば普通に起こるので拒まない */
const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isPoint = (value: unknown): value is Point => isRecord(value) && isCoordinate(value.x) && isCoordinate(value.y)

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH

const isStart = (value: Record<string, unknown>): value is StrokeStart & Record<string, unknown> => isId(value.id) && isPoint(value.point)

const isExtend = (value: Record<string, unknown>): value is StrokeExtend & Record<string, unknown> =>
  isId(value.id) && Array.isArray(value.points) && value.points.length > 0 && value.points.length <= MAX_POINTS_PER_MESSAGE && value.points.every(isPoint)

/**
 * 届いた1通を読み取る。
 *
 * @param payload WebSocketで届いた文字列
 * @throws JSONとして読めない場合、知らない種類の場合、想定した形でない場合
 */
export const parseDrawMessage = (payload: string): DrawMessage => {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new Error('手書きの線を読み取れませんでした（JSONとして読めません）')
  }
  if (!isRecord(value)) throw new Error('手書きの線の形が想定と違います')
  if (value.type === 'start') {
    if (!isStart(value)) throw new Error('手書きの線の形が想定と違います')
    return { type: 'start', id: value.id, point: { x: value.point.x, y: value.point.y } }
  }
  if (value.type === 'extend') {
    if (!isExtend(value)) throw new Error('手書きの線の形が想定と違います')
    return { type: 'extend', id: value.id, points: value.points.map(({ x, y }) => ({ x, y })) }
  }
  throw new Error('手書きの線の種類が想定と違います')
}
