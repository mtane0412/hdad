/**
 * 描く画面（/draw/）
 *
 * 配信中に「ここです」と画面を指したり、簡単な図を描いて説明したりするための画面である（issue #131）。
 * ここで引いた線は中継先（worker/draw-channel.ts）を通り、OBSに載せた合成ページの手書きの素材へその場で現れる。
 * 別のアプリで描いてウィンドウキャプチャで取り込む形を採らないのは、キャプチャ対象・切り抜き・透過の設定を
 * 配信のたびにやり直すことになり、安定しないためである。
 *
 * キャンバスは配信画面と同じ縦横比（16:9）で置く。送るのは画素ではなくキャンバスの大きさに対する比なので、
 * 合成ページ側の箱の大きさが違っても図は歪まない（src/draw/pointer.ts）。
 *
 * 描いている線は自分のキャンバスにも描く。中継先は送り主へ返さないので、返ってくるのを待つと自分の手元だけ
 * 遅れて見えるためである。
 *
 * 引き終えた線はWorker（KV）へ写すので、この画面や合成ページを開き直しても描いたものは残る（issue #133）。
 * 書くのは線を1本引き終えてから数秒まとめたあと（src/draw/save.ts）で、全消しだけは待たずに書く。
 * 保存されているものを読めるまでは書かない（読む前に書くと、前に描いた図を消してしまう）。
 * KVの反映の遅れと合わせて、描いた直後に合成ページを読み込み直すと最後の数本が欠けることはある
 * （docs/decisions/draw.md）。
 *
 * 消しゴムは、なぞった範囲だけを削るのではなく、触れた線を1本まるごと消す（当たり判定は src/draw/erase.ts）。
 * 消したことは線の名前で中継先へ送り、保存は線を引き終えたときと同じく、ポインタを離してから数秒まとめて書く。
 *
 * キャンバスの下には、配信画面を撮った最新の1枚を薄く敷ける（背景のアイコンを押すたびに切り替わる。既定は敷かない）。画面の取り込み
 * （/screen/）が Gyazo へ上げた最後の1枚を読み続ける（src/draw/use-background.ts）。
 * 撮る間隔ぶん古い画面なので、画面の構成を見て「このあたり」を指すためのものである。
 *
 * 道具箱はアイコンだけで1行に収める。色・太さ・背景の濃さはアイコンを押して開く選択肢で選び、
 * 仕様の説明（保存・消しゴムの働き・背景を撮った時刻）は右端のiボタンを押したときだけ出す。
 *
 * 注意: ひとつ戻すは持たない。
 */
import { cn } from 'cn'
import { Contrast, Eraser, ImageIcon, Info, Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from '@/app/router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Toggle } from '@/components/ui/toggle'
import { iconButtonName } from '@/core/icon-button'
import { startCanvasSurface } from '@/core/mount'
import type { DrawApi } from './api'
import { touchedStrokeIds } from './erase'
import { createStrokeId, toRatio } from './pointer'
import { createStrokeSaver } from './save'
import { DEFAULT_COLOR_ID, DEFAULT_WIDTH_ID, DRAW_COLORS, DRAW_WIDTHS, colorOf, widthOf } from './tools'
import type { DrawSocketHandlers, DrawWriter } from './socket'
import { NO_STROKES, applyDrawMessage, type Strokes } from './strokes'
import type { DrawMessage, Point } from './stroke'
import { useDrawBackground } from './use-background'
import { drawStrokes } from './view'

/**
 * 太さの見本を描く基準の箱の幅（画素）。
 *
 * 太さは箱の幅に対する比で持っている（src/draw/tools.ts）ので、道具箱に見本を出すにも基準の幅が要る。
 * ここを大きくすると見本だけが太くなり、実際の線の太さとの対応がずれる。
 */
const SAMPLE_BOX_WIDTH = 360

/** 見本の線の最小の高さ（画素）。細い線でも1本の線として見えるだけの高さは残す */
const SAMPLE_MIN_HEIGHT = 2

/**
 * 背景の濃さ（%）の既定値。
 *
 * 背景は位置の目安にすぎないので、線より目立たないよう少し薄くしておく。
 */
const DEFAULT_BACKGROUND_OPACITY = 60
/** 背景の濃さの下限（%）。0にすると敷いていないのと見分けが付かないので、少し残す */
const MIN_BACKGROUND_OPACITY = 10
/** 背景の濃さの上限（%） */
const MAX_BACKGROUND_OPACITY = 100
/** 背景の濃さを変える刻み（%） */
const BACKGROUND_OPACITY_STEP = 10
/** 百分率を比に直す */
const PERCENT = 100

/** 背景の1枚を撮った時刻の出し方。配信していないあいだは何日も前の画面のこともあるので日付も出す */
const CAPTURED_AT_FORMAT = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 持ち替えられる道具。ペンは線を引き、消しゴムは触れた線を1本まるごと消す */
const TOOLS = [
  { id: 'pen', label: 'ペン', hint: 'ペン', Icon: Pencil },
  { id: 'eraser', label: '消しゴム', hint: '消しゴム（触れた線を1本消す）', Icon: Eraser },
] as const

type ToolId = (typeof TOOLS)[number]['id']

const isToolId = (value: unknown): value is ToolId => TOOLS.some(({ id }) => id === value)

/** 太さの見本。選択肢と、いま選んでいる太さを示すアイコンの両方で使う */
const WidthSample = ({ ratio }: { ratio: number }) => (
  <span aria-hidden className="w-5 shrink-0 rounded-full bg-foreground" style={{ height: Math.max(SAMPLE_MIN_HEIGHT, Math.round(ratio * SAMPLE_BOX_WIDTH)) }} />
)

/**
 * 道具を選ぶラジオの、目に見えない当たり判定。
 *
 * 見た目は枠の側（色そのもの・太さの見本）が持ち、押す操作はラジオ自身が枠いっぱいに広がって受ける。
 * ラベルの側で受けると、ラジオの実体がボタン要素なので押しても選ばれないことがある。
 */
const TOOL_HITBOX = 'absolute inset-0 size-full cursor-pointer aspect-auto rounded-[inherit] border-0 bg-transparent opacity-0'

export interface DrawPageProps {
  /** 中継先へつなぐ。テストで差し替えられるよう受け取る */
  connect(handlers: DrawSocketHandlers): DrawWriter
  /** 描いたものの読み書き（src/draw/api.ts）。テストで差し替えられるよう受け取る */
  api: DrawApi
}

export const DrawPage = ({ connect, api }: DrawPageProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 中継先への窓口。つながる前に描かれた線は送れない（貯めない） */
  const writerRef = useRef<DrawWriter | null>(null)
  /** 自分が描いた線。描画ループが毎フレームここから描き直す */
  const strokesRef = useRef<Strokes>(NO_STROKES)
  /** いま引いている線の名前。ポインタを離すまで同じ名前で点を追加していく */
  const strokeIdRef = useRef<string | null>(null)
  /** 消しゴムを押しているあいだの、ひとつ前の位置。そこから今の位置までに触れた線を消す */
  const eraserPointRef = useRef<Point | null>(null)
  /** 今回の消しゴムの動きで1本でも消したか。離したときに保存するかを決める */
  const erasedByEraserRef = useRef(false)
  /** 待てば直るかもしれない知らせ（切断・つなぎ先の誤り）。直ったら消す */
  const [notice, setNotice] = useState<string | null>(null)
  /** 人が直すまで消えない失敗（キャンバスを使えない場合） */
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * 保存されているものを読めたか。読めるまでは書き込まない。
   *
   * 読む前に書くと、保存されている図（前に描いたもの）を消してしまう。読めなかったときも書かないが、
   * 全消しを押したあとは「保存されているのは何も無い状態」だと分かるので、そこから書き始める。
   */
  const canWriteRef = useRef(false)
  /** 全消しを押したか。読み出しの応答が全消しより後に届いたとき、消した図を描き直さないために見る */
  const erasedRef = useRef(false)
  /** 選んでいる色と太さ。線を引き始めた時点の指定がその線に残る */
  const [colorId, setColorId] = useState(DEFAULT_COLOR_ID)
  const [widthId, setWidthId] = useState(DEFAULT_WIDTH_ID)
  /** 持っている道具 */
  const [toolId, setToolId] = useState<ToolId>('pen')
  /** いま開いている選択肢（色か太さ）。選んだら閉じるために、開き閉じをこちらで持つ */
  const [openOption, setOpenOption] = useState<'color' | 'width' | null>(null)
  /** 背景に配信画面を敷くか。既定は敷かない（使わない配信者に通信を増やさない） */
  const [showBackground, setShowBackground] = useState(false)
  /** 背景の濃さ（%） */
  const [backgroundOpacity, setBackgroundOpacity] = useState(DEFAULT_BACKGROUND_OPACITY)
  const { background, error: backgroundError } = useDrawBackground(api, showBackground)
  /** 読み込めなかった背景の画像のURL。別の1枚に差し替わったら、読み込めたかを見直す */
  const [unreadableImage, setUnreadableImage] = useState<string | null>(null)
  /** 背景について、道具箱の下に出す知らせ（気付いてほしいものだけ）。失敗は赤く出す */
  const backgroundNotice = ((): { text: string; isError: boolean } | null => {
    if (backgroundError !== null) return { text: `背景を読めませんでした: ${backgroundError}`, isError: true }
    if (background.kind === 'none') return { text: '背景にできる配信画面がまだありません。配信中に画面の取り込み（/screen/）を動かすと撮れます。', isError: false }
    if (background.kind === 'image' && background.url === unreadableImage) {
      return { text: '背景の画像を読み込めませんでした（公開範囲が「自分だけ」の画像は使えません。次に撮られた画面から出ます）。', isError: true }
    }
    return null
  })()
  /** 敷いている背景を撮った時刻。iボタンの説明にだけ出す（いつも目に入る必要はないため） */
  const capturedAt = showBackground && background.kind === 'image' ? CAPTURED_AT_FORMAT.format(background.capturedAt) : null
  const backgroundOpacityId = useId()

  /** 引き終えた線をまとめてWorkerへ書く窓口（描いている最中は書かない） */
  const saver = useMemo(
    () => createStrokeSaver({ save: (strokes) => api.save(strokes), onFailure: (message) => setNotice(`描いたものを保存できませんでした: ${message}`) }),
    [api],
  )

  // 開いたときに保存されている線を読み、その続きから描けるようにする。
  // 読み終わる前に引いた線は後ろへ回して残す（読み出しの往復のあいだに描き始めても消えないように）
  useEffect(() => {
    let detached = false
    void api
      .load()
      .then(({ strokes }) => {
        if (detached) return
        // 読めるまでは書けずにいたので、読み終わる前に引いた線はこの時点でまとめて書く
        const drewBeforeRead = strokesRef.current.strokes.length > 0
        // 読み終わる前に全消しを押していたら、読めたものは描き直さない（消した図が戻ってきてしまう）
        if (!erasedRef.current) strokesRef.current = { strokes: [...strokes, ...strokesRef.current.strokes] }
        canWriteRef.current = true
        if (drewBeforeRead) saver.finished(strokesRef.current)
      })
      .catch((error: unknown) =>
        setNotice(
          `保存されている線を読めませんでした（描いたものは保存されません。全部消すと保存を始めます）: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    return () => {
      detached = true
    }
  }, [api, saver])

  // 画面を離れるときは、待っている書き込みを捨てずに書き切る（最後に引いた数本が残らないため）
  useEffect(() => () => saver.flush(), [saver])

  useEffect(() => {
    const writer = connect({
      onStatus: (status) => setNotice(status === 'disconnected' ? '中継先との接続が切れました。再接続します…' : null),
      onWarning: (message) => setNotice(message),
    })
    writerRef.current = writer
    // 画面を離れたら接続を閉じる（閉じないと、ページを行き来するたびに接続が増えていく）
    return () => {
      writer.close()
      writerRef.current = null
    }
  }, [connect])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    let nextFrame = 0
    try {
      const draw = startCanvasSurface(canvas, (ctx, width, height) => drawStrokes(ctx, strokesRef.current, { width, height }))
      const loop = (elapsedMs: number): void => {
        draw(elapsedMs)
        nextFrame = requestAnimationFrame(loop)
      }
      nextFrame = requestAnimationFrame(loop)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
    return () => cancelAnimationFrame(nextFrame)
  }, [])

  /** 引いた線を、自分のキャンバスへ積んだうえで中継先へ送る */
  const send = useCallback((message: DrawMessage): void => {
    strokesRef.current = applyDrawMessage(strokesRef.current, message)
    writerRef.current?.send(message)
  }, [])

  /** 消しゴムが from から to まで動いたあいだに触れた線を、1本ずつ消したこととして送る */
  const moveEraser = useCallback(
    (from: Point, to: Point, rect: DOMRect): void => {
      eraserPointRef.current = to
      for (const id of touchedStrokeIds(strokesRef.current, from, to, rect)) {
        erasedByEraserRef.current = true
        send({ type: 'erase', id })
      }
    },
    [send],
  )

  const pressed = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      // キャンバスの外へ出ても離した合図を受け取れるようにする（線が引きっぱなしにならない）
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const rect = event.currentTarget.getBoundingClientRect()
      const point = toRatio(event.clientX, event.clientY, rect)
      if (toolId === 'eraser') {
        erasedByEraserRef.current = false
        moveEraser(point, point, rect)
        return
      }
      const id = createStrokeId()
      strokeIdRef.current = id
      send({
        type: 'start',
        id,
        point,
        color: colorId,
        width: widthId,
      })
    },
    [send, moveEraser, toolId, colorId, widthId],
  )

  const moved = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      const previousPosition = eraserPointRef.current
      if (previousPosition !== null) {
        const rect = event.currentTarget.getBoundingClientRect()
        moveEraser(previousPosition, toRatio(event.clientX, event.clientY, rect), rect)
        return
      }
      const id = strokeIdRef.current
      // 押していないあいだの動きは線ではない
      if (id === null) return
      send({ type: 'extend', id, points: [toRatio(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())] })
    },
    [send, moveEraser],
  )

  const released = useCallback((): void => {
    const erasedByEraser = eraserPointRef.current !== null && erasedByEraserRef.current
    eraserPointRef.current = null
    erasedByEraserRef.current = false
    // 引いている途中でも消した後でもなければ（押していない指の動きなど）書く理由がない
    if (strokeIdRef.current === null && !erasedByEraser) return
    strokeIdRef.current = null
    // 保存されているものを読めていなければ書かない（読めていない図を上書きしない）
    if (!canWriteRef.current) return
    saver.finished(strokesRef.current)
  }, [saver])

  /**
   * 描いたものをすべて消す。
   *
   * 取り消しの確認は出さない。配信中に確認を挟むほうが、押したのに消えない事故のもとになるためである。
   */
  const clearAll = useCallback((): void => {
    strokeIdRef.current = null
    eraserPointRef.current = null
    erasedRef.current = true
    // 消すのは「保存されているものを全部無かったことにする」操作なので、読めていなくても書いてよい
    canWriteRef.current = true
    send({ type: 'clear' })
    // 消したことは待たずに書く（残っていると困る向きの操作なので遅らせない）
    saver.saveNow(strokesRef.current)
  }, [send, saver])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>手書き</CardTitle>
          <CardDescription>
            ここに描いた線が、配信画面にそのまま出ます。映すには
            <Link href="/overlay/" className="underline">
              オーバーレイ
            </Link>
            で「手書き」を素材として置いてください。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {failure !== null && (
            <p role="alert" className="text-sm text-destructive">
              描く場所を用意できません: {failure}
            </p>
          )}
          {notice !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {/* 道具はすべてアイコンで1行に収める。名前は読み上げとホバー（title）にだけ渡し、
              仕様の説明は右端のiボタンに寄せる（docs/decisions/draw.md） */}
          <div className="flex items-center gap-1 overflow-x-auto rounded-lg border bg-card p-1.5 shadow-sm">
            {/* RadioGroup は既定で grid w-full なので、横一列に収めるため w-auto で打ち消す */}
            <RadioGroup
              value={toolId}
              onValueChange={(newValue) => {
                if (isToolId(newValue)) setToolId(newValue)
              }}
              aria-label="道具"
              className="flex w-auto flex-row items-center gap-1"
            >
              {TOOLS.map(({ id, label, hint, Icon }) => (
                <span
                  key={id}
                  title={hint}
                  className={cn(
                    'relative flex size-8 shrink-0 items-center justify-center rounded-md border transition has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                    toolId === id ? 'border-foreground bg-accent' : 'border-transparent hover:bg-accent/50',
                  )}
                >
                  <Icon aria-hidden className="size-4" />
                  <RadioGroupItem value={id} aria-label={label} className={TOOL_HITBOX} />
                </span>
              ))}
            </RadioGroup>

            <Separator orientation="vertical" className="mx-1 h-6 self-center" />

            {/* 色と太さは、いま選んでいるものの見た目をアイコンにし、押すと選択肢を開く */}
            <Popover open={openOption === 'color'} onOpenChange={(open) => setOpenOption(open ? 'color' : null)}>
              <PopoverTrigger render={<Button type="button" variant="ghost" size="icon" className="size-8" {...iconButtonName('線の色')} />}>
                <span aria-hidden className="size-5 rounded-full border-2 border-border" style={{ backgroundColor: colorOf(colorId).value }} />
              </PopoverTrigger>
              {/* 開いた選択肢はダイアログとして読み上げられるので、何を選ぶ場かの名前を付ける */}
              <PopoverContent className="w-auto" aria-label="線の色を選ぶ">
                <RadioGroup
                  value={colorId}
                  onValueChange={(newValue) => {
                    setColorId(String(newValue))
                    setOpenOption(null)
                  }}
                  aria-label="線の色"
                  className="flex w-auto flex-row items-center gap-1.5"
                >
                  {DRAW_COLORS.map((color) => (
                    <span
                      key={color.id}
                      title={color.label}
                      className={cn(
                        'relative flex size-7 shrink-0 rounded-full border-2 transition has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                        colorId === color.id ? 'border-foreground ring-2 ring-foreground/30' : 'border-border hover:border-muted-foreground',
                      )}
                      style={{ backgroundColor: color.value }}
                    >
                      {/* 選ぶ操作はラジオ自身が受ける（枠の側で受けると、押しても選ばれないことがある） */}
                      <RadioGroupItem value={color.id} aria-label={color.label} className={TOOL_HITBOX} />
                    </span>
                  ))}
                </RadioGroup>
              </PopoverContent>
            </Popover>

            <Popover open={openOption === 'width'} onOpenChange={(open) => setOpenOption(open ? 'width' : null)}>
              <PopoverTrigger render={<Button type="button" variant="ghost" size="icon" className="size-8" {...iconButtonName('線の太さ')} />}>
                <WidthSample ratio={widthOf(widthId).ratio} />
              </PopoverTrigger>
              <PopoverContent className="w-auto" aria-label="線の太さを選ぶ">
                <RadioGroup
                  value={widthId}
                  onValueChange={(newValue) => {
                    setWidthId(String(newValue))
                    setOpenOption(null)
                  }}
                  aria-label="線の太さ"
                  className="flex w-auto flex-row items-center gap-1.5"
                >
                  {DRAW_WIDTHS.map((widthOption) => (
                    <span
                      key={widthOption.id}
                      title={widthOption.label}
                      className={cn(
                        'relative flex h-7 w-9 shrink-0 items-center justify-center rounded-md border transition has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                        widthId === widthOption.id ? 'border-foreground bg-accent' : 'border-border hover:bg-accent/50',
                      )}
                    >
                      <WidthSample ratio={widthOption.ratio} />
                      <RadioGroupItem value={widthOption.id} aria-label={widthOption.label} className={TOOL_HITBOX} />
                    </span>
                  ))}
                </RadioGroup>
              </PopoverContent>
            </Popover>

            <Separator orientation="vertical" className="mx-1 h-6 self-center" />

            {/* 背景は押すたびに敷く・外すが入れ替わる。敷いているあいだは押された見た目になる */}
            <Toggle pressed={showBackground} onPressedChange={setShowBackground} className="size-8 min-w-8 border border-transparent px-0 aria-pressed:border-foreground aria-pressed:bg-accent" {...iconButtonName('配信画面を背景に敷く')}>
              <ImageIcon />
            </Toggle>
            {/* 濃さは敷いているあいだしか意味がないので、そのあいだだけ出す */}
            {showBackground && (
              <Popover>
                <PopoverTrigger render={<Button type="button" variant="ghost" size="icon" className="size-8" {...iconButtonName('背景の濃さを変える')} />}>
                  <Contrast />
                </PopoverTrigger>
                <PopoverContent className="w-48" aria-label="背景の濃さを変える">
                  <div className="flex items-center gap-2">
                    <Slider
                      aria-labelledby={backgroundOpacityId}
                      className="flex-1"
                      min={MIN_BACKGROUND_OPACITY}
                      max={MAX_BACKGROUND_OPACITY}
                      step={BACKGROUND_OPACITY_STEP}
                      value={[backgroundOpacity]}
                      onValueChange={(next) => setBackgroundOpacity(Array.isArray(next) ? (next[0] ?? DEFAULT_BACKGROUND_OPACITY) : next)}
                    />
                    <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{backgroundOpacity}%</span>
                  </div>
                  <span id={backgroundOpacityId} className="sr-only">
                    背景の濃さ
                  </span>
                </PopoverContent>
              </Popover>
            )}

            <Separator orientation="vertical" className="mx-1 h-6 self-center" />

            {/* ゴミ箱の形だけで何をするかは伝わるのでアイコンだけにする。戻せない操作なので色でも伝える
                （塗りつぶしの赤は常時目立ちすぎるため、アイコンだけを赤くする） */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={clearAll}
              className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
              {...iconButtonName('全部消す')}
            >
              <Trash2 />
            </Button>

            <Popover>
              <PopoverTrigger
                render={<Button type="button" variant="ghost" size="icon" className="ml-auto size-8 text-muted-foreground" {...iconButtonName('手書きについて')} />}
              >
                <Info />
              </PopoverTrigger>
              <PopoverContent align="end" className="text-xs" aria-label="手書きについて">
                <ul className="list-disc space-y-1 pl-4">
                  <li>描いたものは残ります（OBSで開き直しても出ます）</li>
                  <li>消しゴムは触れた線を1本消す・ゴミ箱はすべて消す</li>
                  {capturedAt !== null && <li>背景は {capturedAt} に撮影（配信外は最後の配信の画面）</li>}
                </ul>
              </PopoverContent>
            </Popover>
          </div>

          {showBackground && backgroundNotice !== null && (
            <p className={cn('text-sm', backgroundNotice.isError ? 'text-destructive' : 'text-muted-foreground')}>{backgroundNotice.text}</p>
          )}

          {/* 配信画面と同じ縦横比にする（比が違うと、合成ページに出たときに図が歪む）。
              背景はキャンバスの下に敷き、描く操作はキャンバスが受ける */}
          <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-neutral-900">
            {showBackground && background.kind === 'image' && (
              <img
                src={background.url}
                alt="背景に敷いた配信画面"
                // キャンバスと同じ枠いっぱいに広げる（配信画面も16:9なので、線の位置と画面の位置が揃う）
                className="pointer-events-none absolute inset-0 size-full object-fill"
                style={{ opacity: backgroundOpacity / PERCENT }}
                onError={() => setUnreadableImage(background.url)}
              />
            )}
            <canvas
              ref={canvasRef}
              aria-label="配信画面に描く場所"
              className="absolute inset-0 size-full touch-none"
              onPointerDown={pressed}
              onPointerMove={moved}
              onPointerUp={released}
              onPointerCancel={released}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
