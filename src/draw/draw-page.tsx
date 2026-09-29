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
 * 注意: 描いたものを残す仕組みはまだ無い（issue #133）。この画面を閉じても合成ページ側の線は消えず、
 * 逆に合成ページを開き直すと、それまでに引いた線は出ない。
 * 注意: 消しゴムとひとつ戻すは持たない。まず全消しで足りるかを実際の配信で確かめてから決める（issue #132）。
 */
import { cn } from 'cn'
import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@/app/router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { startCanvasSurface } from '@/core/mount'
import { createStrokeId, toRatio } from './pointer'
import { DEFAULT_COLOR_ID, DEFAULT_WIDTH_ID, DRAW_COLORS, DRAW_WIDTHS } from './tools'
import type { DrawSocketHandlers, DrawWriter } from './socket'
import { NO_STROKES, applyDrawMessage, type Strokes } from './strokes'
import type { DrawMessage } from './stroke'
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
 * 道具を選ぶラジオの、目に見えない当たり判定。
 *
 * 見た目は枠の側（色そのもの・太さの見本）が持ち、押す操作はラジオ自身が枠いっぱいに広がって受ける。
 * ラベルの側で受けると、ラジオの実体がボタン要素なので押しても選ばれないことがある。
 */
const TOOL_HITBOX = 'absolute inset-0 size-full cursor-pointer aspect-auto rounded-[inherit] border-0 bg-transparent opacity-0'

export interface DrawPageProps {
  /** 中継先へつなぐ。テストで差し替えられるよう受け取る */
  connect(handlers: DrawSocketHandlers): DrawWriter
}

export const DrawPage = ({ connect }: DrawPageProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 中継先への窓口。つながる前に描かれた線は送れない（貯めない） */
  const writerRef = useRef<DrawWriter | null>(null)
  /** 自分が描いた線。描画ループが毎フレームここから描き直す */
  const strokesRef = useRef<Strokes>(NO_STROKES)
  /** いま引いている線の名前。ポインタを離すまで同じ名前で点を足していく */
  const strokeIdRef = useRef<string | null>(null)
  /** 待てば直るかもしれない知らせ（切断・つなぎ先の誤り）。直ったら消す */
  const [notice, setNotice] = useState<string | null>(null)
  /** 人が直すまで消えない失敗（キャンバスを使えない場合） */
  const [failure, setFailure] = useState<string | null>(null)
  /** 選んでいる色と太さ。線を引き始めた時点の指定がその線に残る */
  const [colorId, setColorId] = useState(DEFAULT_COLOR_ID)
  const [widthId, setWidthId] = useState(DEFAULT_WIDTH_ID)

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

  const 押した = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      const id = createStrokeId()
      strokeIdRef.current = id
      // キャンバスの外へ出ても離した合図を受け取れるようにする（線が引きっぱなしにならない）
      event.currentTarget.setPointerCapture?.(event.pointerId)
      送る({
        type: 'start',
        id,
        point: toRatio(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect()),
        color: colorId,
        width: widthId,
      })
    },
    [送る, colorId, widthId],
  )

  const 動かした = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      const id = strokeIdRef.current
      // 押していないあいだの動きは線ではない
      if (id === null) return
      送る({ type: 'extend', id, points: [toRatio(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())] })
    },
    [送る],
  )

  const 離した = useCallback((): void => {
    strokeIdRef.current = null
  }, [])

  /**
   * 描いたものをすべて消す。
   *
   * 取り消しの確認は出さない。配信中に確認を挟むほうが、押したのに消えない事故のもとになるためである。
   */
  const 全部消す = useCallback((): void => {
    strokeIdRef.current = null
    送る({ type: 'clear' })
  }, [送る])

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

            {/* 消したものは戻せないので、アイコンだけにせず文字も残す（src/core/icon-button.ts の注意） */}
            <Button type="button" variant="outline" size="sm" onClick={全部消す}>
              <Trash2 />
              全部消す
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
          <p className="text-sm text-muted-foreground">描いたものは、合成ページ（OBSのブラウザソース）を開き直すと消えます。</p>
        </CardContent>
      </Card>
    </div>
  )
}
