/**
 * campfire（焚き火）の炎のかたまり・火の粉・光のゆらぎの計算に対するテスト
 *
 * どれも経過時間（秒）から直接求めるので、「この時刻にはこの姿」を確かめられる。
 * 炎のかたまりと火の粉は、生まれてから消えるまでを繰り返し、消えるたびに別の場所から出直す。
 * 高さ（height）は上向きで、大きさは焚き火の大きさを1とする比率で表す。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../core/background'
import { campfire, emberSpark, firelight, flameColor, flamePuff } from './campfire'

/** 全体の形を確かめるために調べる、炎のかたまりの番号の数 */
const SAMPLED_PUFF_COUNT = 40
/** 炎のかたまりの一生を細かく見るときの刻み（秒） */
const TIME_STEP = 0.01

/**
 * 指定した番号の炎のかたまりを時刻順に追い、1回ぶんの一生（生まれて消えるまで）の姿を集める。
 * 一生の途中から数えないよう、life が小さくなった（次の世代に移った）あとの1周を取り出す。
 */
const collectOneLife = (index: number): readonly ReturnType<typeof flamePuff>[] => {
  const lives: ReturnType<typeof flamePuff>[][] = [[]]
  let previousLife = flamePuff(index, 0).life
  for (let time = TIME_STEP; lives.length < 3 && time < 30; time += TIME_STEP) {
    const puff = flamePuff(index, time)
    if (puff.life < previousLife) lives.push([])
    lives[lives.length - 1]?.push(puff)
    previousLife = puff.life
  }
  const wholeLife = lives[1]
  if (!wholeLife) throw new Error('炎のかたまりの一生を集められませんでした')
  return wholeLife
}

describe('flamePuff（炎のかたまり）', () => {
  it('同じ番号・同じ時刻なら、いつ計算しても同じ姿になる（フレーム落ちしても飛ばない）', () => {
    expect(flamePuff(5, 12.34)).toEqual(flamePuff(5, 12.34))
  })

  it('生まれてから消えるまで、上へ昇り続ける', () => {
    const life = collectOneLife(3)
    // 揺れは横方向だけなので、高さは刻みごとに必ず増える
    for (let step = 1; step < life.length; step++) {
      expect(life[step]?.height).toBeGreaterThan(life[step - 1]?.height ?? Number.POSITIVE_INFINITY)
    }
  })

  it('生まれる瞬間と消える瞬間は透明になる（突然現れたり消えたりしない）', () => {
    const life = collectOneLife(3)
    expect(life[0]?.alpha).toBeLessThan(0.1)
    expect(life[life.length - 1]?.alpha).toBeLessThan(0.1)
    expect(life[Math.floor(life.length / 3)]?.alpha).toBeGreaterThan(0.3)
  })

  it('昇るほど温度が下がり、小さくなる（根元が明るく、先が赤く細い炎の形になる）', () => {
    const life = collectOneLife(3)
    const early = life[Math.floor(life.length * 0.1)]
    const late = life[Math.floor(life.length * 0.9)]
    if (!early || !late) throw new Error('一生の前半と後半を取り出せませんでした')
    expect(late.heat).toBeLessThan(early.heat)
    expect(late.radius).toBeLessThan(early.radius)
  })

  it('消えて出直すと、別の場所から昇る', () => {
    // 一生の始まりを何回ぶんか集める。生まれた直後は高さがほぼ0で揺れもほぼ無いので、x は根元の位置を表す
    const samples = Array.from({ length: 2000 }, (_, step) => flamePuff(3, step * TIME_STEP))
    const birthPositions = samples
      .filter((puff, step) => step > 0 && puff.life < (samples[step - 1]?.life ?? 0))
      .map((puff) => puff.x)
    expect(birthPositions.length).toBeGreaterThan(3)
    // 揺れだけでは届かない幅（焚き火の大きさの1割）以上に、根元の位置が散らばる
    expect(Math.max(...birthPositions) - Math.min(...birthPositions)).toBeGreaterThan(0.1)
  })

  it('全体として、上へ行くほど横幅がすぼまる', () => {
    const lower: number[] = []
    const upper: number[] = []
    for (let index = 0; index < SAMPLED_PUFF_COUNT; index++) {
      for (let time = 0; time < 20; time += 0.1) {
        const puff = flamePuff(index, time)
        if (puff.height < 0.15) lower.push(Math.abs(puff.x))
        if (puff.height > 0.6) upper.push(Math.abs(puff.x))
      }
    }
    const average = (values: readonly number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length
    expect(average(upper)).toBeLessThan(average(lower))
  })
})

describe('emberSpark（火の粉）', () => {
  it('同じ番号・同じ時刻なら同じ姿になる', () => {
    expect(emberSpark(2, 8.5)).toEqual(emberSpark(2, 8.5))
  })

  it('炎より高いところまで舞い上がるものがある', () => {
    let highest = 0
    for (let index = 0; index < 30; index++) {
      for (let time = 0; time < 30; time += 0.1) {
        const spark = emberSpark(index, time)
        if (spark.alpha > 0) highest = Math.max(highest, spark.height)
      }
    }
    expect(highest).toBeGreaterThan(1)
  })

  it('見えているあいだは描画領域の上端を越えない（地面は高さの8割、焚き火の大きさは短い辺の0.56倍なので、上端は約1.43）', () => {
    for (let index = 0; index < 60; index++) {
      for (let time = 0; time < 60; time += 0.1) {
        const spark = emberSpark(index, time)
        if (spark.alpha > 0) expect(spark.height).toBeLessThan(1.43)
      }
    }
  })

  it('不透明度は0〜1に収まる', () => {
    for (let time = 0; time < 30; time += 0.07) {
      const { alpha } = emberSpark(1, time)
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThanOrEqual(1)
    }
  })
})

describe('firelight（光のゆらぎ）', () => {
  it('どの時刻でも0〜1に収まる', () => {
    for (let time = 0; time < 300; time += 0.13) {
      const light = firelight(time)
      expect(light).toBeGreaterThanOrEqual(0)
      expect(light).toBeLessThanOrEqual(1)
    }
  })

  it('一定の明るさに止まらず、ゆらぐ', () => {
    const lights = Array.from({ length: 200 }, (_, step) => firelight(step * 0.1))
    expect(Math.max(...lights) - Math.min(...lights)).toBeGreaterThan(0.3)
  })
})

describe('flameColor（温度に対応する炎の色）', () => {
  it('いちばん低い温度は濃い赤、いちばん高い温度は白に近い色になる', () => {
    expect(flameColor(0)).toBe('#961a04')
    expect(flameColor(1)).toBe('#fff4d2')
  })
})

describe('campfire の描画', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * 描いた内容を記録する描画コンテキストの代役を作る。
   * 実際のブラウザの Canvas は無いので、drawImage と clearRect の呼び出しと、合成の設定だけを観測する。
   */
  const createRecordingContext = () => {
    const images: number[][] = []
    const clears: number[] = []
    const context = {
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '',
      drawImage: (_image: unknown, ...box: number[]) => images.push(box),
      clearRect: () => clears.push(1),
      createRadialGradient: () => ({ addColorStop: () => undefined }),
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      fillRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      translate: () => undefined,
      rotate: () => undefined,
      scale: () => undefined,
      beginPath: () => undefined,
      arc: () => undefined,
      ellipse: () => undefined,
      roundRect: () => undefined,
      fill: () => undefined,
    }
    return { context, images, clears }
  }

  /** スプライト用の canvas を、記録用の代役に差し替えて描画関数を作る */
  const createRenderer = (params: { bg: string; speed: number }) => {
    const sprite = createRecordingContext().context
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => sprite }) })
    return campfire.create(params)
  }

  const renderFrame = (render: (frame: Frame) => void, time: number) => {
    const recording = createRecordingContext()
    render({
      ctx: recording.context as unknown as CanvasRenderingContext2D,
      width: 1920,
      height: 1080,
      time,
      now: new Date('2026-10-31T21:00:00+09:00'),
    })
    return recording
  }

  it('描き終えたら合成の設定を元に戻す（戻さないと次のコマの背景の塗りが加算になる）', () => {
    const { context, images } = renderFrame(createRenderer({ bg: '#0a0910', speed: 1 }), 12.3)
    expect(images.length).toBeGreaterThan(0)
    expect(context.globalAlpha).toBe(1)
    expect(context.globalCompositeOperation).toBe('source-over')
  })

  it('背景が透過なら毎コマ前の絵を消し、色なら消さずに塗る', () => {
    expect(renderFrame(createRenderer({ bg: 'transparent', speed: 1 }), 1).clears).toHaveLength(1)
    expect(renderFrame(createRenderer({ bg: '#0a0910', speed: 1 }), 1).clears).toHaveLength(0)
  })

  it('速さが0なら、時刻が進んでも同じ絵のまま止まる', () => {
    const render = createRenderer({ bg: '#0a0910', speed: 0 })
    expect(renderFrame(render, 1).images).toEqual(renderFrame(render, 50).images)
  })

  it('速さが1なら、時刻が進むと絵が変わる', () => {
    const render = createRenderer({ bg: '#0a0910', speed: 1 })
    expect(renderFrame(render, 1).images).not.toEqual(renderFrame(render, 50).images)
  })
})
