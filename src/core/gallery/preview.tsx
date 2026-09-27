/**
 * 素材のプレビュー（iframe で試し見する枠）
 *
 * ギャラリー（1素材を調整しながら試し見する）と、合成オーバーレイの管理画面（オーバーレイ1枚の重なりを
 * 試し見する。issue #106）の両方で要るので、gallery.tsx から切り出して共有する（入力欄の ParamField、
 * URLの組み立ての serializeParams と同じ扱い）。
 *
 * iframe は実寸（OBSのブラウザソースに設定する大きさ）で描き、表示枠の幅に合わせて縮小する。
 * 実寸で描くのは、文字の大きさや線の太さが配信画面と同じ比になるようにするためである。
 */
import { useEffect, useRef, useState } from 'react'

/** プレビューの実寸（px） */
export interface PreviewSize {
  readonly width: number
  readonly height: number
}

/**
 * 値の変化が delay ミリ秒のあいだ止まってから、その値を返す。
 *
 * 入力のたびにプレビューを読み込み直さないために使う（打っている途中で作り直すと、素材の起動が
 * 何度も走る）。
 */
export const useSettled = <T,>(value: T, delay: number): T => {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return settled
}

/** プレビュー。iframe は実寸で描画し、表示枠の幅に合わせて縮小する */
export const Preview = ({ url, title, size }: { url: string; title: string; size: PreviewSize }) => {
  const screenRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)

  useEffect(() => {
    const screen = screenRef.current
    if (!screen) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / size.width)
    })
    observer.observe(screen)
    return () => observer.disconnect()
  }, [size.width])

  return (
    <div
      ref={screenRef}
      // 実寸より大きく引き伸ばすと文字や線がぼやけるため、表示枠は実寸の幅までにする。市松模様は透過の背景を見分けるため
      className="relative w-full overflow-hidden rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-size-[24px_24px]"
      style={{ aspectRatio: `${size.width} / ${size.height}`, maxWidth: size.width }}
    >
      <iframe
        // src を書き換えるとブラウザの履歴が積まれるため、URLが変わるたびに iframe ごと作り直す
        key={url}
        src={url}
        title={title}
        width={size.width}
        height={size.height}
        className="absolute top-0 left-0 origin-top-left border-0"
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  )
}
