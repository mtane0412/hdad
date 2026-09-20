/**
 * 素材ページ（canvas 1枚のページ）の起動処理
 *
 * ページ内の canvas（data-<属性名> に素材ID）を見つけ、
 * URLのクエリパラメータを解析して描画ループを開始する。
 * 起動に失敗した場合は、OBS上でも原因が分かるよう画面にエラー内容を表示する。
 * カテゴリごとのエントリスクリプト（core/stage.ts, clock/stage.ts）から、自分のレジストリを渡して呼び出す。
 */
import type { BackgroundDefinition } from './background'
import { ParamError, parseParams } from './params'

const MILLISECONDS_PER_SECOND = 1000

/** 起動対象の指定 */
export interface MountTarget {
  /** そのカテゴリのレジストリ */
  readonly definitions: readonly BackgroundDefinition[]
  /** 素材IDを持つ data 属性の名前（background なら data-background） */
  readonly attribute: string
  /** エラー表示で素材を指す呼び名（「背景」「時計」など） */
  readonly noun: string
}

const start = ({ definitions, attribute, noun }: MountTarget): void => {
  const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-${attribute}]`)
  if (!canvas) throw new Error(`data-${attribute} 属性を持つ canvas 要素が見つかりません`)

  const id = canvas.dataset[attribute]
  const definition = definitions.find((candidate) => candidate.id === id)
  if (!definition) throw new Error(`${noun}「${id}」はレジストリに登録されていません`)

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas の2D描画コンテキストを取得できませんでした')

  const params = parseParams(definition.schema, new URLSearchParams(location.search))
  const render = definition.create(params)

  const draw = (elapsed: number): void => {
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
      time: elapsed / MILLISECONDS_PER_SECOND,
      now: new Date(),
    })
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
}

const showError = (error: unknown, noun: string): void => {
  const lines =
    error instanceof ParamError
      ? ['URLパラメータに問題があります', ...error.problems]
      : [`${noun}を表示できません`, error instanceof Error ? error.message : String(error)]
  const panel = document.createElement('pre')
  panel.className = 'stage-error'
  panel.setAttribute('role', 'alert')
  panel.textContent = lines.join('\n')
  document.body.append(panel)
}

/**
 * 素材ページを起動する。
 *
 * @param target 起動対象（レジストリと data 属性名）
 * @throws 起動に失敗した場合。画面にエラーを表示したうえで、コンソールでも追えるよう投げ直す
 */
export const mountStage = (target: MountTarget): void => {
  try {
    start(target)
  } catch (error) {
    showError(error, target.noun)
    throw error
  }
}
