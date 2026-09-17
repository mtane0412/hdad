/**
 * 背景ページの起動処理
 *
 * backgrounds/<id>/index.html の canvas（data-background 属性に背景ID）を見つけ、
 * URLのクエリパラメータを解析して描画ループを開始する。
 * 起動に失敗した場合は、OBS上でも原因が分かるよう画面にエラー内容を表示する。
 */
import { backgrounds } from '../backgrounds/registry'
import { ParamError, parseParams } from './params'

const MILLISECONDS_PER_SECOND = 1000

const start = (): void => {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-background]')
  if (!canvas) throw new Error('data-background 属性を持つ canvas 要素が見つかりません')

  const id = canvas.dataset.background
  const definition = backgrounds.find((background) => background.id === id)
  if (!definition) throw new Error(`背景「${id}」はレジストリに登録されていません`)

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas の2D描画コンテキストを取得できませんでした')

  const params = parseParams(definition.schema, new URLSearchParams(location.search))
  const render = definition.create(params)

  const draw = (now: number): void => {
    // ウィンドウやOBSのソースサイズが変わったら、canvas の解像度を合わせ直す
    const ratio = window.devicePixelRatio
    const pixelWidth = Math.round(window.innerWidth * ratio)
    const pixelHeight = Math.round(window.innerHeight * ratio)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)

    render({
      ctx,
      width: window.innerWidth,
      height: window.innerHeight,
      time: now / MILLISECONDS_PER_SECOND,
    })
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
}

const showError = (error: unknown): void => {
  const lines =
    error instanceof ParamError
      ? ['URLパラメータに問題があります', ...error.problems]
      : ['背景を表示できません', error instanceof Error ? error.message : String(error)]
  const panel = document.createElement('pre')
  panel.className = 'stage-error'
  panel.setAttribute('role', 'alert')
  panel.textContent = lines.join('\n')
  document.body.append(panel)
}

try {
  start()
} catch (error) {
  showError(error)
  throw error
}
