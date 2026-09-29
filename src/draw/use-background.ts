/**
 * 描く画面の背景（配信画面を撮った最新の1枚）の読み込み
 *
 * 描く画面（/draw/）は、背景を敷くと決めているあいだ Worker（GET /api/admin/draw/background）を読みに行き続け、
 * 新しい1枚が届いたら差し替える。画像は画面の取り込み（/screen/）が撮って Worker へ送ったもので、配信中に
 * 撮るたびに置き換わり、配信していないあいだは最後に配信した時点の1枚のまま残る（worker/draw-background.ts）。
 *
 * 読みに行くたびに手元の1枚の印（ETag）を添えるので、変わっていなければ画像は送られてこない。
 *
 * 注意: 敷かないと決めているあいだは読みに行かない（背景を使わない配信者に通信を増やさない）。
 * 注意: 画像は Blob から作ったURLで表示するので、差し替えたときと敷くのをやめたときに解放する（しないと溜まり続ける）。
 */
import { useEffect, useState } from 'react'
import type { DrawApi } from './api'

/**
 * 背景を読みに行く間隔（ミリ秒）。
 *
 * 画面の取り込みが撮る間隔の最短（15秒。worker/screen-config.ts の MIN_INTERVAL_SECONDS）に合わせる。
 * これより短くしても新しい1枚は来ず、長くすると撮れているのに古い画面が残る。
 */
export const BACKGROUND_POLL_MS = 15_000

/** 背景の状態 */
export type DrawBackgroundState =
  /** 敷いていない、または最初の1回を読んでいる途中 */
  | { readonly kind: 'idle' }
  /** まだ1枚も無い */
  | { readonly kind: 'none' }
  /** 敷いている1枚 */
  | { readonly kind: 'image'; readonly url: string; readonly capturedAt: number }

/**
 * 背景を敷くと決めているあいだ、配信画面の最新の1枚を読み続ける。
 *
 * @param api 描く画面からの読み書き（src/draw/api.ts）
 * @param enabled 背景を敷くか
 * @returns 背景の状態と、読めなかったときの理由（読めたら消える）
 */
export const useDrawBackground = (api: DrawApi, enabled: boolean): { background: DrawBackgroundState; error: string | null } => {
  const [background, setBackground] = useState<DrawBackgroundState>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let 離れた = false
    /** 読みに行っている途中か。応答が間隔より遅いときに、読みに行くのを重ねない */
    let 読んでいる = false
    /** 手元の1枚の印。次に読むときに添える */
    let 印: string | null = null
    /** 手元の1枚のURL。差し替えたときと敷くのをやめたときに解放する */
    let 表示中のURL: string | null = null

    const 読む = async (): Promise<void> => {
      if (読んでいる) return
      読んでいる = true
      try {
        const result = await api.loadBackground(印)
        if (離れた) return
        setError(null)
        if (result.kind === 'unchanged') return
        if (表示中のURL !== null) URL.revokeObjectURL(表示中のURL)
        表示中のURL = null
        if (result.kind === 'none') {
          印 = null
          setBackground({ kind: 'none' })
          return
        }
        印 = result.etag
        表示中のURL = URL.createObjectURL(result.image)
        setBackground({ kind: 'image', url: 表示中のURL, capturedAt: result.capturedAt })
      } catch (e) {
        // 読めなくても手元の1枚は残す（次に読めれば差し替わる）。理由は画面に出す
        if (!離れた) setError(e instanceof Error ? e.message : String(e))
      } finally {
        読んでいる = false
      }
    }

    void 読む()
    const 時計 = setInterval(() => void 読む(), BACKGROUND_POLL_MS)
    return () => {
      離れた = true
      clearInterval(時計)
      if (表示中のURL !== null) URL.revokeObjectURL(表示中のURL)
      setBackground({ kind: 'idle' })
      setError(null)
    }
  }, [api, enabled])

  return { background, error }
}
