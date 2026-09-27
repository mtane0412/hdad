/**
 * プレビューの受け渡し（管理画面 ↔ プレビューとして開いた合成ページ）
 *
 * 管理画面（overlay-page.tsx）は、編集中の構成をそのままプレビューへ渡す。Worker から読ませないのは、
 * 保存はその時点で配信画面（OBSに貼った合成ページ）へ反映されるためで、保存してからでないと確かめられない
 * プレビューでは「配信画面に出してから確かめる」ことになり、プレビューの意味が無くなる（issue #106）。
 *
 * 渡す道は同じサイトの窓どうしの postMessage で、順序はこうなる。
 * 1. プレビュー（合成ページ）が ?demo=true で開き、親の窓へ「構成を待っている」と知らせる（previewReadyMessage）
 * 2. 親（管理画面）がそれを受けて、いまの編集中の構成を渡す（previewLayoutMessage）
 *
 * 待つ側から先に知らせるのは、iframe の読み込みが終わる時期を親からは決められないためである。
 * 編集が進んだときは親が iframe を作り直すので、この受け渡しは開くたびに1回で済む。
 *
 * 注意: 同じ窓には他の知らせ（開発サーバーの再読み込みなど）も届くので、自分たちの知らせでなければ
 * 読まずに undefined を返す。いっぽう自分たちの知らせなのに形が違えばエラーにする（Fail-Fast。
 * 黙って空の構成にすると、プレビューに何も映らない理由が分からなくなる）。形の確かめは、Worker の応答に
 * 使うもの（api.ts の readOverlays）をそのまま使う。
 */
import { readOverlays } from './api'
import type { Overlay } from './layout'

/** プレビューが「構成を待っている」と知らせる種類 */
const READY = 'hdad-overlay-preview-ready'

/** 親が編集中の構成を渡す知らせの種類 */
const LAYOUT = 'hdad-overlay-preview-layout'

/** 知らせの種類を読む（種類を持たない知らせでは undefined） */
const typeOf = (data: unknown): string | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const { type } = data as { type?: unknown }
  return typeof type === 'string' ? type : undefined
}

/** プレビューが親へ送る「構成を待っている」の知らせ */
export const previewReadyMessage = (): { type: string } => ({ type: READY })

/**
 * 親がプレビューへ渡す、編集中の構成の知らせ。
 *
 * @param overlays プレビューに映すオーバーレイ（ふだんは編集中の1つだけ）
 */
export const previewLayoutMessage = (overlays: readonly Overlay[]): { type: string; overlays: readonly Overlay[] } => ({
  type: LAYOUT,
  overlays,
})

/** 構成を渡す相手（プレビューの窓）。送る口だけを見る */
interface PreviewTarget {
  postMessage(message: unknown, targetOrigin: string): void
}

/**
 * 構成を渡せる相手か。
 *
 * 窓かどうかを instanceof では確かめられない（iframe の中の窓は、この窓とは別の Window になる）ので、
 * 送る口を持っているかだけを見る。送る相手は同じサイトの iframe だと origin で確かめてあるので、
 * これで足りる。
 */
const senderOf = (source: unknown): PreviewTarget | undefined => {
  if (typeof source !== 'object' || source === null) return undefined
  const { postMessage } = source as Partial<PreviewTarget>
  return typeof postMessage === 'function' ? (source as PreviewTarget) : undefined
}

/**
 * 「構成を待っている」と知らせてきたプレビューへ、いまの編集中の構成を渡し返す。
 *
 * 自分たちの知らせでなければ何もしない（同じ窓には他の知らせも届く）。よそのサイトからの知らせにも
 * 渡さない（構成にはこの配信の素材の並びが入るため、同じサイトの窓だけを相手にする）。
 *
 * @param event 届いた知らせ（window の message から受け取ったもの）
 * @param origin このサイトの起点（window.location.origin）
 * @param overlays いま編集中の構成（プレビューに映すオーバーレイ）
 * @returns 渡したか
 */
export const replyPreviewLayout = (
  { data, origin: from, source }: { data: unknown; origin: string; source: unknown },
  origin: string,
  overlays: readonly Overlay[],
): boolean => {
  if (from !== origin || typeOf(data) !== READY) return false
  const sender = senderOf(source)
  if (sender === undefined) return false
  sender.postMessage(previewLayoutMessage(overlays), origin)
  return true
}

/**
 * 届いた知らせから、編集中の構成を読む。
 *
 * @returns 構成（自分たちの知らせでなければ undefined）
 * @throws 自分たちの知らせなのに、構成の形が想定と違う場合
 */
export const readPreviewLayout = (data: unknown): Overlay[] | undefined => (typeOf(data) === LAYOUT ? readOverlays(data) : undefined)
