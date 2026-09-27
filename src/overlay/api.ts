/**
 * 合成オーバーレイの構成の読み出し（オーバーレイ用API の呼び出し）
 *
 * 合成ページ（overlay/stage/index.html）は素材ページなのでログインを持たず、ほかのオーバーレイと同じ
 * オーバーレイ用キー（URLの ?key=）で Worker に受け付けてもらう。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の形はここで確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って読める素材だけを描くと、配信中は
 * 「まだ置いていない」のか「Workerの作りが変わって届かなくなった」のか見分けが付かない。
 */
import { createCaller, isRecord, readList } from '../core/api'
import { ITEM_KINDS, type ItemKind, type Overlay, type OverlayItem } from './layout'

const PATH = '/api/overlay/layout'

/** 位置と大きさとして読めるか */
const isRect = (value: unknown): boolean =>
  isRecord(value) && typeof value.x === 'number' && typeof value.y === 'number' && typeof value.width === 'number' && typeof value.height === 'number'

/** 素材1件として読めるか。種類は描ける6つだけを通す */
const isOverlayItem = (value: unknown): value is OverlayItem =>
  isRecord(value) &&
  (ITEM_KINDS as readonly string[]).includes(value.kind as ItemKind) &&
  typeof value.id === 'string' &&
  typeof value.params === 'string' &&
  isRect(value.rect)

/** オーバーレイ1つとして読めるか（中の素材まで確かめる） */
const isOverlay = (value: unknown): value is Overlay =>
  isRecord(value) && typeof value.name === 'string' && Array.isArray(value.items) && value.items.every((item: unknown) => isOverlayItem(item))

/**
 * 応答の本文から構成（オーバーレイの並び）を読む。想定した形でなければエラーにする。
 *
 * 管理画面の読み書き（admin-api.ts）も同じ形を受け取るので、確かめをここで共有する（focus/api.ts の
 * readFocusTarget と同じ扱い）。
 */
export const readOverlays = (body: unknown): Overlay[] => readList(body, 'overlays', isOverlay)

export interface OverlayLayoutApi {
  /**
   * 構成を読む。
   *
   * @returns オーバーレイの並び（保存された並びのまま。自分のオーバーレイの絞り込みは layout.ts が行う）
   */
  read(): Promise<Overlay[]>
}

/**
 * 構成の読み出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createOverlayLayoutApi = (fetchImpl: typeof fetch, key: string): OverlayLayoutApi => {
  const call = createCaller(fetchImpl)
  const path = `${PATH}?key=${encodeURIComponent(key)}`

  return {
    async read() {
      return readOverlays(await call(path))
    },
  }
}
