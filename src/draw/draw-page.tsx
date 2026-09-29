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
 * 注意: ひとつ戻すは持たない。
 */
import { cn } from 'cn'
import { Eraser, Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@/app/router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { iconButtonName } from '@/core/icon-button'
import { startCanvasSurface } from '@/core/mount'
import type { DrawApi } from './api'
import { touchedStrokeIds } from './erase'
import { createStrokeId, toRatio } from './pointer'
import { createStrokeSaver } from './save'
import { DEFAULT_COLOR_ID, DEFAULT_WIDTH_ID, DRAW_COLORS, DRAW_WIDTHS } from './tools'
import type { DrawSocketHandlers, DrawWriter } from './socket'
import { NO_STROKES, applyDrawMessage, type Strokes } from './strokes'
import type { DrawMessage, Point } from './stroke'
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

/** 持ち替えられる道具。ペンは線を引き、消しゴムは触れた線を1本まるごと消す */
const TOOLS = [
  { id: 'pen', label: 'ペン', Icon: Pencil },
  { id: 'eraser', label: '消しゴム', Icon: Eraser },
] as const

type ToolId = (typeof TOOLS)[number]['id']

const isToolId = (value: unknown): value is ToolId => TOOLS.some(({ id }) => id === value)

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
  /** いま引いている線の名前。ポインタを離すまで同じ名前で点を足していく */
  const strokeIdRef = useRef<string | null>(null)
  /** 消しゴムを押しているあいだの、ひとつ前の位置。そこから今の位置までに触れた線を消す */
  const eraserPointRef = useRef<Point | null>(null)
  /** 今回の消しゴムの動きで1本でも消したか。離したときに保存するかを決める */
  const 消しゴムで消したRef = useRef(false)
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
  const 書いてよいRef = useRef(false)
  /** 全消しを押したか。読み出しの応答が全消しより後に届いたとき、消した図を描き直さないために見る */
  const 消したRef = useRef(false)
  /** 選んでいる色と太さ。線を引き始めた時点の指定がその線に残る */
  const [colorId, setColorId] = useState(DEFAULT_COLOR_ID)
  const [widthId, setWidthId] = useState(DEFAULT_WIDTH_ID)
  /** 持っている道具 */
  const [toolId, setToolId] = useState<ToolId>('pen')

  /** 引き終えた線をまとめてWorkerへ書く窓口（描いている最中は書かない） */
  const saver = useMemo(
    () => createStrokeSaver({ save: (strokes) => api.save(strokes), onFailure: (message) => setNotice(`描いたものを保存できませんでした: ${message}`) }),
    [api],
  )

  // 開いたときに保存されている線を読み、その続きから描けるようにする。
  // 読み終わる前に引いた線は後ろへ回して残す（読み出しの往復のあいだに描き始めても消えないように）
  useEffect(() => {
    let 離れた = false
    void api
      .load()
      .then(({ strokes }) => {
        if (離れた) return
        // 読めるまでは書けずにいたので、読み終わる前に引いた線はこの時点でまとめて書く
        const 読む前に引いていた = strokesRef.current.strokes.length > 0
        // 読み終わる前に全消しを押していたら、読めたものは描き直さない（消した図が戻ってきてしまう）
        if (!消したRef.current) strokesRef.current = { strokes: [...strokes, ...strokesRef.current.strokes] }
        書いてよいRef.current = true
        if (読む前に引いていた) saver.finished(strokesRef.current)
      })
      .catch((error: unknown) =>
        setNotice(
          `保存されている線を読めませんでした（描いたものは保存されません。全部消すと保存を始めます）: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    return () => {
      離れた = true
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
    let 次のフレーム = 0
    try {
      const draw = startCanvasSurface(canvas, (ctx, width, height) => drawStrokes(ctx, strokesRef.current, { width, height }))
      const ループ = (elapsedMs: number): void => {
        draw(elapsedMs)
        次のフレーム = requestAnimationFrame(ループ)
      }
      次のフレーム = requestAnimationFrame(ループ)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
    return () => cancelAnimationFrame(次のフレーム)
  }, [])

  /** 引いた線を、自分のキャンバスへ積んだうえで中継先へ送る */
  const 送る = useCallback((message: DrawMessage): void => {
    strokesRef.current = applyDrawMessage(strokesRef.current, message)
    writerRef.current?.send(message)
  }, [])

  /** 消しゴムが from から to まで動いたあいだに触れた線を、1本ずつ消したこととして送る */
  const 消しゴムを動かす = useCallback(
    (from: Point, to: Point, rect: DOMRect): void => {
      eraserPointRef.current = to
      for (const id of touchedStrokeIds(strokesRef.current, from, to, rect)) {
        消しゴムで消したRef.current = true
        送る({ type: 'erase', id })
      }
    },
    [送る],
  )

  const 押した = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      // キャンバスの外へ出ても離した合図を受け取れるようにする（線が引きっぱなしにならない）
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const rect = event.currentTarget.getBoundingClientRect()
      const point = toRatio(event.clientX, event.clientY, rect)
      if (toolId === 'eraser') {
        消しゴムで消したRef.current = false
        消しゴムを動かす(point, point, rect)
        return
      }
      const id = createStrokeId()
      strokeIdRef.current = id
      送る({
        type: 'start',
        id,
        point,
        color: colorId,
        width: widthId,
      })
    },
    [送る, 消しゴムを動かす, toolId, colorId, widthId],
  )

  const 動かした = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      const 前の位置 = eraserPointRef.current
      if (前の位置 !== null) {
        const rect = event.currentTarget.getBoundingClientRect()
        消しゴムを動かす(前の位置, toRatio(event.clientX, event.clientY, rect), rect)
        return
      }
      const id = strokeIdRef.current
      // 押していないあいだの動きは線ではない
      if (id === null) return
      送る({ type: 'extend', id, points: [toRatio(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())] })
    },
    [送る, 消しゴムを動かす],
  )

  const 離した = useCallback((): void => {
    const 消しゴムで消した = eraserPointRef.current !== null && 消しゴムで消したRef.current
    eraserPointRef.current = null
    消しゴムで消したRef.current = false
    // 引いている途中でも消した後でもなければ（押していない指の動きなど）書く理由がない
    if (strokeIdRef.current === null && !消しゴムで消した) return
    strokeIdRef.current = null
    // 保存されているものを読めていなければ書かない（読めていない図を上書きしない）
    if (!書いてよいRef.current) return
    saver.finished(strokesRef.current)
  }, [saver])

  /**
   * 描いたものをすべて消す。
   *
   * 取り消しの確認は出さない。配信中に確認を挟むほうが、押したのに消えない事故のもとになるためである。
   */
  const 全部消す = useCallback((): void => {
    strokeIdRef.current = null
    eraserPointRef.current = null
    消したRef.current = true
    // 消すのは「保存されているものを全部無かったことにする」操作なので、読めていなくても書いてよい
    書いてよいRef.current = true
    送る({ type: 'clear' })
    // 消したことは待たずに書く（残っていると困る向きの操作なので遅らせない）
    saver.saveNow(strokesRef.current)
  }, [送る, saver])

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
          {/* 道具は形で選べるようにする（色は色そのもの、太さは太さの見本）。名前は読み上げにだけ渡す。
              RadioGroup は既定で grid w-full なので、横一列に収めるため w-auto で打ち消す */}
          <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-1.5 shadow-sm">
            {/* 道具だけは文字も出す。消しゴムの形だけでは、なぞった範囲を削るのか線を丸ごと消すのか分からないため
                （docs/decisions/draw.md） */}
            <RadioGroup
              value={toolId}
              onValueChange={(値) => {
                if (isToolId(値)) setToolId(値)
              }}
              aria-label="道具"
              className="flex w-auto flex-row items-center gap-1.5"
            >
              {TOOLS.map(({ id, label, Icon }) => (
                <span
                  key={id}
                  className={cn(
                    'relative flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border px-2 text-xs transition has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                    toolId === id ? 'border-foreground bg-accent' : 'border-border hover:bg-accent/50',
                  )}
                >
                  <Icon aria-hidden className="size-4" />
                  <span aria-hidden>{label}</span>
                  <RadioGroupItem value={id} aria-label={label} className={TOOL_HITBOX} />
                </span>
              ))}
            </RadioGroup>

            <Separator orientation="vertical" className="mx-1 h-6 self-center" />

            <RadioGroup
              value={colorId}
              onValueChange={(値) => setColorId(String(値))}
              aria-label="線の色"
              className="flex w-auto flex-row items-center gap-1.5"
            >
              {DRAW_COLORS.map((色) => (
                <span
                  key={色.id}
                  className={cn(
                    'relative flex size-7 shrink-0 rounded-full border-2 transition has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                    colorId === 色.id ? 'border-foreground ring-2 ring-foreground/30' : 'border-border hover:border-muted-foreground',
                  )}
                  style={{ backgroundColor: 色.value }}
                >
                  {/* 選ぶ操作はラジオ自身が受ける（枠の側で受けると、押しても選ばれないことがある） */}
                  <RadioGroupItem value={色.id} aria-label={色.label} className={TOOL_HITBOX} />
                </span>
              ))}
            </RadioGroup>

            <Separator orientation="vertical" className="mx-1 h-6 self-center" />

            <RadioGroup
              value={widthId}
              onValueChange={(値) => setWidthId(String(値))}
              aria-label="線の太さ"
              className="flex w-auto flex-row items-center gap-1.5"
            >
              {DRAW_WIDTHS.map((太さ) => (
                <span
                  key={太さ.id}
                  className={cn(
                    'relative flex h-7 w-9 shrink-0 items-center justify-center rounded-md border transition has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                    widthId === 太さ.id ? 'border-foreground bg-accent' : 'border-border hover:bg-accent/50',
                  )}
                >
                  <span
                    aria-hidden
                    className="w-5 shrink-0 rounded-full bg-foreground"
                    style={{ height: Math.max(SAMPLE_MIN_HEIGHT, Math.round(太さ.ratio * SAMPLE_BOX_WIDTH)) }}
                  />
                  <RadioGroupItem value={太さ.id} aria-label={太さ.label} className={TOOL_HITBOX} />
                </span>
              ))}
            </RadioGroup>

            <Separator orientation="vertical" className="mx-1 h-6 self-center" />

            {/* ゴミ箱の形だけで何をするかは伝わるのでアイコンだけにする。戻せない操作なので色でも伝える
                （塗りつぶしの赤は常時目立ちすぎるため、アイコンだけを赤くする） */}
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={全部消す}
              className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
              {...iconButtonName('全部消す')}
            >
              <Trash2 />
            </Button>
          </div>

          <canvas
            ref={canvasRef}
            aria-label="配信画面に描く場所"
            // 配信画面と同じ縦横比にする（比が違うと、合成ページに出たときに図が歪む）
            className="aspect-video w-full touch-none rounded-md border bg-neutral-900"
            onPointerDown={押した}
            onPointerMove={動かした}
            onPointerUp={離した}
            onPointerCancel={離した}
          />
          <p className="text-sm text-muted-foreground">
            描いたものは残るので、合成ページ（OBSのブラウザソース）を開き直しても出ます。消しゴムは触れた線を1本まるごと消し、ゴミ箱はすべてを消します。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
