/**
 * canvas を使う素材（壁紙・時計）の起動処理
 *
 * 素材ごとのページ（wallpaper/<id>/index.html・clock/<id>/index.html）と、素材を重ねる合成ページ
 * （overlay/index.html）の両方から使う。どちらも「canvas 1枚に1つの素材を描く」ところは同じで、
 * 違うのは canvas の大きさの基準と、描画ループを誰が回すかである。
 *
 * - 素材ごとのページ: canvas はページ全体に広がり、このファイルが描画ループ（requestAnimationFrame）を回す
 * - 合成ページ: canvas はレイヤーの箱の中に置かれ、描画ループは段で1本だけ合成ページが回す
 *   （レイヤーごとに張ると、ページをまとめてもループの本数が元に戻る。issue #101）
 *
 * そのため、このファイルは「1フレームぶんの描画」（DrawFrame）を返す形（startCanvasLayer）を土台にし、
 * 素材ごとのページ向けにループまで面倒を見る形（mountStage）をその上に置く。
 * canvas の大きさは窓（window.innerWidth）ではなく**canvas 自身のCSS上の大きさ**を基準にするので、
 * レイヤーの箱に入れてもそのまま動く（大きさの変化は ResizeObserver で追う）。
 *
 * 起動に失敗した場合は、OBS上でも原因が分かるよう画面にエラー内容を表示する（showError）。
 * canvas を使わない素材（チャットボックス・アラートなど）も、エラー表示だけをここから使う。
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

/**
 * 1フレームぶんの描画。
 *
 * @param elapsedMs ページを開いてからの経過時間（ミリ秒。requestAnimationFrame が渡す値）
 */
export type DrawFrame = (elapsedMs: number) => void

/**
 * 箱のCSS上の大きさから canvas の解像度（画素数）を決める。
 *
 * まだ大きさを測れていない（0）ときも1画素は確保する。canvas は幅・高さに0を受け取らないためである。
 */
export const canvasPixels = (cssSize: number, ratio: number): number => Math.max(1, Math.round(cssSize * ratio))

/**
 * レジストリから素材の定義を探す。
 *
 * @param noun エラー表示で素材を指す呼び名
 * @throws 登録されていないIDが指定された場合
 */
export const findDefinition = (
  definitions: readonly BackgroundDefinition[],
  id: string | undefined,
  noun: string,
): BackgroundDefinition => {
  const definition = definitions.find((candidate) => candidate.id === id)
  if (!definition) throw new Error(`${noun}「${id}」はレジストリに登録されていません`)
  return definition
}

/**
 * canvas 1枚に素材1つを描く準備をし、1フレームぶんの描画を返す。
 *
 * 描画ループは呼び出し側が回す（合成ページでは段で1本にまとめる）。
 *
 * @param canvas 描画先。CSS上の大きさ（箱に入れた場合は箱の大きさ）が描画の基準になる
 * @param definition 素材の定義（レジストリの1件）
 * @param searchParams 素材のパラメータ（素材ごとのページでは location.search、合成ページでは構成が持つ文字列）
 * @throws ParamError パラメータに問題がある場合
 * @throws Error 2D描画コンテキストを取得できない場合
 */
export const startCanvasLayer = (
  canvas: HTMLCanvasElement,
  definition: BackgroundDefinition,
  searchParams: URLSearchParams,
): DrawFrame => {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas の2D描画コンテキストを取得できませんでした')

  const params = parseParams(definition.schema, searchParams)
  const render = definition.create(params)

  // 描画の基準は canvas 自身のCSS上の大きさ（= 箱の大きさ）。OBSのソースサイズやレイヤーの位置を
  // 変えたときに合わせ直せるよう、変化は ResizeObserver で追う
  let width = canvas.clientWidth
  let height = canvas.clientHeight
  new ResizeObserver((entries) => {
    const entry = entries.at(-1)
    if (!entry) return
    width = entry.contentRect.width
    height = entry.contentRect.height
  }).observe(canvas)

  return (elapsedMs) => {
    // 大きさを測れていないあいだ（レイアウト前や、箱が隠れているとき）は描かない
    if (width === 0 || height === 0) return

    const ratio = window.devicePixelRatio
    const pixelWidth = canvasPixels(width, ratio)
    const pixelHeight = canvasPixels(height, ratio)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)

    render({ ctx, width, height, time: elapsedMs / MILLISECONDS_PER_SECOND, now: new Date() })
  }
}

/**
 * 失敗の表示の出どころ。
 *
 * 1つのレイヤーの箱には、別々の理由の表示が同時に出うる（合成ページの注目コメントは、取り上げているものの
 * 読み出しとチャットの接続の両方を使う）。直ったものだけを消せるように、表示に出どころを添えておく。
 *
 * - layer: レイヤーの起動・描画の失敗。人が直すまで消えない
 * - read: 定期的に読み直すものの失敗。次の読み出しが成功したら消す
 * - chat: チャットの接続の失敗。読み直しでは直らないので、読み出しの成功では消さない
 */
export type ErrorSource = 'layer' | 'read' | 'chat'

/** 出どころを持たせる data 属性の名前（dataset のキー） */
const ERROR_SOURCE_KEY = 'errorSource'

/**
 * 起動に失敗した原因を画面に表示する（OBS上ではコンソールを見られないため）。
 *
 * canvas を使わない素材（チャットボックス・アラートなど）の起動処理からも使う。
 *
 * @param box 表示先。既定はページ全体（body）で、合成ページはそのレイヤーの箱を渡す。
 *   1つのレイヤーの失敗で配信画面のその段全体を赤く染めないためで、同じ段のほかのレイヤーは
 *   動かし続ける（issue #101 で決めた、Fail-Fast に意識して設けた例外）
 * @param source 失敗の出どころ。既定は人が直すまで消さないもの（layer）
 */
export const showError = (
  error: unknown,
  noun: string,
  box: HTMLElement = document.body,
  source: ErrorSource = 'layer',
): void => {
  const lines =
    error instanceof ParamError
      ? ['URLパラメータに問題があります', ...error.problems]
      : [`${noun}を表示できません`, error instanceof Error ? error.message : String(error)]
  const panel = document.createElement('pre')
  panel.className = 'stage-error'
  panel.setAttribute('role', 'alert')
  panel.dataset[ERROR_SOURCE_KEY] = source
  panel.textContent = lines.join('\n')
  box.append(panel)
}

/**
 * 箱に出した失敗の表示のうち、同じ出どころのものを消す。
 *
 * 合成ページは同じレイヤーを定期的に読み直すので、一度の失敗の表示を消せないと、
 * その後の読み出しが成功しても配信中ずっと赤い panel が残ってしまう。
 * 消すのはその箱に直接置いた、指定した出どころの表示だけである。ほかのレイヤーの箱にも、
 * 同じ箱に出ている別の理由の表示にも手を出さない（読み出しが直っても、まだ直っていない
 * チャットの接続の失敗は残す）。
 */
export const clearError = (box: HTMLElement, source: ErrorSource): void => {
  for (const panel of box.querySelectorAll(`:scope > .stage-error[data-error-source="${source}"]`)) panel.remove()
}

/**
 * 素材ごとのページを起動する（canvas をページ全体に広げ、描画ループを回す）。
 *
 * @param target 起動対象（レジストリと data 属性名）
 * @throws 起動に失敗した場合。画面にエラーを表示したうえで、コンソールでも追えるよう投げ直す
 */
export const mountStage = (target: MountTarget): void => {
  try {
    const { definitions, attribute, noun } = target
    const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-${attribute}]`)
    if (!canvas) throw new Error(`data-${attribute} 属性を持つ canvas 要素が見つかりません`)

    const definition = findDefinition(definitions, canvas.dataset[attribute], noun)
    const draw = startCanvasLayer(canvas, definition, new URLSearchParams(location.search))

    const loop = (elapsedMs: number): void => {
      draw(elapsedMs)
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  } catch (error) {
    showError(error, target.noun)
    throw error
  }
}
