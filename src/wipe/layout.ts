/**
 * 構成の中からワイプを探す
 *
 * ワイプはチャットを自分で読み上げるので、裏方の読み上げ（src/speech/task.ts）と同時に動くと、同じ発言が二重に読まれる。
 * 裏方の読み上げは起動のときにこれで構成を確かめ、ワイプがあれば読み上げを始めない。
 * 構成全体でワイプが1つまでであることは、Worker（worker/overlay-layout.ts）が保存のときに確かめている。
 */
import type { Overlay } from '../overlay/layout'

/** ワイプを置いたオーバーレイの名前を返す。どこにも無ければ null */
export const wipeOverlayNameOf = (overlays: readonly Overlay[]): string | null =>
  overlays.find((overlay) => overlay.items.some((item) => item.kind === 'wipe'))?.name ?? null
