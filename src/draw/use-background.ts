/**
 * 描く画面の背景（配信画面を撮った最新の1枚）の読み込み
 *
 * 描く画面（/draw/）は、背景を敷くと決めているあいだ Worker（GET /api/admin/draw/background）を読みに行き続け、
 * 新しい1枚が撮られていたら差し替える。画像は画面の取り込み（/screen/）が配信中に撮って Gyazo へ上げたもので、
 * Worker が返すのはその画像のURLだけである（画像はブラウザが Gyazo から直接読む）。配信していないあいだは、
 * 最後に配信した時点の1枚のまま残る。
 *
 * 読みに行くたびに手元の1枚の印（ETag。画像ID）を添えるので、変わっていなければ Worker は Gyazo を呼ばない。
 *
 * 注意: 敷かないと決めているあいだは読みに行かない（背景を使わない配信者に通信を増やさない）。
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
    let detached = false
    /** 読みに行っている途中か。応答が間隔より遅いときに、読みに行くのを重ねない */
    let loading = false
    /** 手元の1枚の印。次に読むときに添える */
    let marker: string | null = null

    const load = async (): Promise<void> => {
      if (loading) return
      loading = true
      try {
        const result = await api.loadBackground(marker)
        if (detached) return
        setError(null)
        if (result.kind === 'unchanged') return
        if (result.kind === 'none') {
          marker = null
          setBackground({ kind: 'none' })
          return
        }
        marker = result.etag
        setBackground({ kind: 'image', url: result.url, capturedAt: result.capturedAt })
      } catch (e) {
        // 読めなくても手元の1枚は残す（次に読めれば差し替わる）。理由は画面に出す
        if (!detached) setError(e instanceof Error ? e.message : String(e))
      } finally {
        loading = false
      }
    }

    void load()
    const timer = setInterval(() => void load(), BACKGROUND_POLL_MS)
    return () => {
      detached = true
      clearInterval(timer)
      setBackground({ kind: 'idle' })
      setError(null)
    }
  }, [api, enabled])

  return { background, error }
}
