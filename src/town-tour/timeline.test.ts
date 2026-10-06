/**
 * 市町村紹介の再生の進み方（timeline.ts）のテスト
 *
 * 場面は「再生を始めた時刻」「紹介が届いた時刻」と現在時刻だけから決まる（フレーム間の状態を持たない）。
 * 決めた流れは次のとおり。
 * 0. 市町村の形だけをシルエットで出し、都道府県当てクイズを出す（15秒。4秒ごとにヒントを1つ足す）。
 *    チャットで正解が出たら、その時点でクイズを終える。終えたら正解（と最初の正解者）を3秒出す（issue #251）
 * 1. クイズを終えたら日本全体を映す（1.5秒）
 * 2. 市町村へズームしながら形を塗る（3秒）
 * 3. 大見出し（7秒。前半1.5秒は「この町、実は…」だけで溜める）→ ゆさぶりの項目（6秒ずつ）→ オチの項目（最後の項目。5秒）
 *    → 配信者への振り（6秒）の順に流す。紹介が届くのが遅ければ、届くまで待ってから始める
 * 4. 振りを流し終えたら日本全体へ引き、全国制覇マップを出す（6秒）。引ききった後に今回の市町村を数え、節目の一文を出す（issue #252）
 * 5. レイドなら、レイド元を名誉町民に任命する認定証を出して（8秒）終わる（issue #253）。キーワードでは出さずに制覇マップで終わる
 *
 * ナレーション（issue #255）を読み上げる再生では、冒頭の一文を着地で読み、大見出し・項目・振りはそれぞれの出だしで読む。
 * 読み上げが場面の長さに収まらなければ、場面を「読み上げの長さ＋余白」まで延ばす（決まった長さより短くはしない）。
 */
import { describe, expect, it } from 'vitest'
import { NARRATION_TAIL_MS, type Narration } from './narration'
import type { TownTourCall, TownTourIntro } from './tour'
import { QUIZ_HINT_INTERVAL_MS, QUIZ_MS } from './quiz'
import {
  BOND_MS,
  CERTIFICATE_MS,
  CONQUEST_MS,
  CONQUEST_STAMP_MS,
  CONQUEST_ZOOM_MS,
  CUE_MS,
  HOOK_MS,
  HOOK_TEASE_MS,
  IMAGE_MS,
  JAPAN_HOLD_MS,
  POINT_MS,
  PUNCHLINE_MS,
  REVEAL_MS,
  ZOOM_END_MS,
  sceneAt,
  tourSpanOf,
  visitRecordAtOf,
  type Playback,
} from './timeline'

const STARTED_AT = 1_000_000

const tobetsuCall: TownTourCall = {
  code: '01303',
  prefecture: '北海道',
  county: '石狩郡',
  name: '当別町',
  headline: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
  quizId: 'quiz-tobetsu',
  quizHeadline: '山田花子さんのレイドを記念して、本日は当別町をご紹介します',
  // 場面の進み方は音に左右されないので、どの枠も鳴らさない設定にしておく
  sound: {
    slots: { bgm: null, opening: null, zoom: null, landing: null, item: null, closing: null },
    bgmVolume: 0.3,
    effectVolume: 0.6,
  },
  population: 14974,
  area: 422.86,
  audience: { kind: 'raid', count: 50 },
  visited: ['01100'],
  visit: { occasion: 'raid', userName: '山田花子' },
  honoraryCitizen: '山田花子',
  raider: { login: 'yamada_hanako', viewers: 30 },
  narration: false,
}

/** 当別町を数えた制覇マップ（札幌市だけを紹介済みで、当別町で2つめ） */
const tobetsuConquest: Playback['conquest'] = { before: 1, after: 2, total: 1747, visited: new Set(['01100']), milestones: [] }

/** 大見出しと項目2つの紹介 */
const tobetsuIntro: TownTourIntro = {
  article: { title: '当別町', url: 'https://ja.wikipedia.org/wiki/%E5%BD%93%E5%88%A5%E7%94%BA' },
  tour: {
    hook: '北欧の街並みがある米どころ',
    points: [
      { label: 'どこにある？', text: '石狩平野の北東部にある町です。' },
      { label: '名物', text: '当別米が名物です。' },
    ],
    cue: '当別米、食べたことありますか？',
  },
  image: null,
  bond: null,
  bondFailure: null,
}

/** 代表画像のある紹介（作者とライセンス付き） */
const tobetsuIntroWithImage: TownTourIntro = {
  ...tobetsuIntro,
  image: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tobetsu_Sweden_Hills.jpg/1280px-Tobetsu_Sweden_Hills.jpg',
    artist: '当別の写真家',
    license: 'CC BY-SA 4.0',
    caption: 'スウェーデンヒルズの家並み',
  },
  bond: null,
  bondFailure: null,
}

/** 地図の形から作ったヒント（都道府県の市町村の数 → 地方 → 隣り合う都道府県） */
const tobetsuHints = ['市町村の数: 185', '北海道地方にあります', '陸で接する都道府県はありません']

/** 誰も正解しなかったクイズ */
const unansweredQuiz: Playback['quiz'] = { hints: tobetsuHints, answer: null, unopenedAt: null }

/** 正解者が出なかった再生では、クイズの長さいっぱいで日本地図へ移る */
const MAP_START = QUIZ_MS

/** 再生を始めてから readyAfterMs ミリ秒後に紹介が届いた再生（誰も正解しなかった） */
const readyPlayback = (readyAfterMs: number): Playback => ({
  call: tobetsuCall,
  startedAt: STARTED_AT,
  intro: { status: 'ready', intro: tobetsuIntro, readyAt: STARTED_AT + readyAfterMs, narration: null },
  quiz: unansweredQuiz,
  conquest: tobetsuConquest,
})

const loadingPlayback: Playback = { call: tobetsuCall, startedAt: STARTED_AT, intro: { status: 'loading' }, quiz: unansweredQuiz, conquest: tobetsuConquest }

/** 再生を始めてから answeredAfterMs ミリ秒後に「たなか」さんが正解した再生（紹介は始めた時点で届いている） */
const answeredPlayback = (answeredAfterMs: number): Playback => ({
  ...readyPlayback(0),
  quiz: { hints: tobetsuHints, answer: { userName: 'たなか', answeredAt: STARTED_AT + answeredAfterMs }, unopenedAt: null },
})

/** 紹介が届いた再生の、届いた紹介の状態（tourSpanOf に渡すもの） */
const readyOf = ({ intro }: Playback) => {
  if (intro.status !== 'ready') throw new Error('紹介が届いた再生を渡してください')
  return intro
}

describe('sceneAt のクイズ', () => {
  it('始めた直後は、都道府県を伏せた一文と、市町村の名前を入れた問いを出し、ヒントはまだ出さない', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT)).toMatchObject({
      headlineText: '山田花子さんのレイドを記念して、本日は当別町をご紹介します',
      quiz: { label: '都道府県当てクイズ', question: '当別町はどこの都道府県でしょう？ チャットで答えてね', hints: [] },
      reveal: null,
      fill: 0,
    })
  })

  it('ヒントは、4秒ごとに1つずつ足していく', () => {
    const hintsAt = (ms: number) => sceneAt(loadingPlayback, STARTED_AT + ms).quiz?.hints

    expect(hintsAt(QUIZ_HINT_INTERVAL_MS - 1)).toEqual([])
    expect(hintsAt(QUIZ_HINT_INTERVAL_MS)).toEqual(['市町村の数: 185'])
    expect(hintsAt(QUIZ_HINT_INTERVAL_MS * 3)).toEqual(tobetsuHints)
  })

  it('誰も正解しなければ、クイズの長さが過ぎたところで時間切れとして正解を出し、冒頭の一文を都道府県入りに戻す', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + QUIZ_MS)).toMatchObject({
      headlineText: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
      quiz: null,
      reveal: { label: '時間切れ！', text: '正解は北海道' },
      zoom: 0,
    })
  })

  it('チャットで正解が出たら、その時点でクイズを終え、最初の正解者の名前と正解を出す', () => {
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 - 1).quiz).not.toBeNull()
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 + 1)).toMatchObject({
      quiz: null,
      reveal: { label: '最初の正解: たなかさん', text: '正解は北海道' },
    })
  })

  it('出題を開けなかったら、その時点でクイズを打ち切り、受け付けられなかった旨と正解を出す（答えても届かない問いを出し続けない）', () => {
    const unopened: Playback = { ...loadingPlayback, quiz: { hints: tobetsuHints, answer: null, unopenedAt: STARTED_AT + 800 } }

    expect(sceneAt(unopened, STARTED_AT + 1000)).toMatchObject({
      quiz: null,
      reveal: { label: 'クイズを受け付けられませんでした', text: '正解は北海道' },
    })
  })

  it('正解を出す場面は3秒で終わる', () => {
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 + REVEAL_MS).reveal).toBeNull()
  })

  it('正解が早く出たら、そのぶん早く日本地図からズームし、紹介を流しはじめる', () => {
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 + JAPAN_HOLD_MS).zoom).toBe(0)
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 + ZOOM_END_MS + 1).item?.line.kind).toBe('hook')
  })
})

describe('sceneAt', () => {
  it('クイズを終えた直後は日本全体を映し、市町村はまだ塗らない', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + MAP_START)).toMatchObject({ zoom: 0, fill: 0, item: null, done: false })
  })

  it('ズームが終わると、市町村の形を塗り終えている', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + MAP_START + ZOOM_END_MS)).toMatchObject({ zoom: 1, fill: 1 })
  })

  it('ズームが終わっても紹介が届いていなければ、項目を出さずに待つ', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + MAP_START + ZOOM_END_MS + 5000)).toMatchObject({ item: null, waiting: true, credit: null, done: false })
  })

  it('紹介がズームより先に届いていれば、ズームが終わったところから大見出しを流す', () => {
    const scene = sceneAt(readyPlayback(2000), STARTED_AT + MAP_START + ZOOM_END_MS + HOOK_MS / 2)

    expect(scene.item).toMatchObject({ line: { kind: 'hook', label: 'この町、実は…', text: '北欧の街並みがある米どころ' }, opacity: 1, textOpacity: 1 })
    expect(scene.credit).toBe('紹介文: Wikipedia「当別町」（CC BY-SA 4.0）')
  })

  it('大見出しの前半は、見出し（「この町、実は…」）だけを出して文を伏せておく', () => {
    expect(sceneAt(readyPlayback(0), STARTED_AT + MAP_START + ZOOM_END_MS + HOOK_TEASE_MS / 2).item).toMatchObject({ line: { kind: 'hook' }, textOpacity: 0 })
  })

  it('紹介が遅れて届いたら、届いた時刻から流しはじめる', () => {
    const readyAfterMs = MAP_START + ZOOM_END_MS + 3000

    expect(sceneAt(readyPlayback(readyAfterMs), STARTED_AT + readyAfterMs - 1).item).toBeNull()
    expect(sceneAt(readyPlayback(readyAfterMs), STARTED_AT + readyAfterMs + HOOK_MS / 2).item?.line.kind).toBe('hook')
  })

  it('大見出しのあとは、ゆさぶりの項目を6秒、オチ（最後の項目）を5秒、配信者への振りを6秒流す', () => {
    const at = (ms: number) => sceneAt(readyPlayback(0), STARTED_AT + MAP_START + ZOOM_END_MS + ms).item?.line.label

    expect(at(HOOK_MS + 1)).toBe('どこにある？')
    expect(at(HOOK_MS + POINT_MS - 1)).toBe('どこにある？')
    expect(at(HOOK_MS + POINT_MS + 1)).toBe('名物')
    expect(at(HOOK_MS + POINT_MS + PUNCHLINE_MS - 1)).toBe('名物')
    expect(at(HOOK_MS + POINT_MS + PUNCHLINE_MS + 1)).toBe('ところで…')
  })

  it('大見出しが空なら、ズームが終わったところから項目を流す', () => {
    const noHook: Playback = {
      call: tobetsuCall,
      startedAt: STARTED_AT,
      intro: { status: 'ready', intro: { ...tobetsuIntro, tour: { ...tobetsuIntro.tour, hook: '' } }, readyAt: STARTED_AT, narration: null },
      quiz: unansweredQuiz,
      conquest: tobetsuConquest,
    }

    expect(sceneAt(noHook, STARTED_AT + MAP_START + ZOOM_END_MS + 1).item?.line.label).toBe('どこにある？')
  })

  it('紹介を作れなかったら、その場で終わる（失敗は素材の箱に出す）', () => {
    const failed: Playback = { call: tobetsuCall, startedAt: STARTED_AT, intro: { status: 'failed' }, quiz: unansweredQuiz, conquest: tobetsuConquest }

    expect(sceneAt(failed, STARTED_AT + 1000).done).toBe(true)
  })
})

describe('sceneAt の代表画像（issue #254）', () => {
  /** 代表画像のある紹介が、始めた時点で届いている再生（誰も正解しなかった） */
  const withImage: Playback = { ...readyPlayback(0), intro: { status: 'ready', intro: tobetsuIntroWithImage, readyAt: STARTED_AT, narration: null } }
  /** ズームが着地した時刻（再生を始めてからのミリ秒） */
  const LANDING = MAP_START + ZOOM_END_MS

  it('ズームが着地したら、大見出しの前に画像を写真の説明と一緒に出し、作者とライセンスを出典と一緒に出す', () => {
    const scene = sceneAt(withImage, STARTED_AT + LANDING + IMAGE_MS / 2)

    expect(scene.item).toBeNull()
    expect(scene.image).toEqual({
      url: tobetsuIntroWithImage.image?.url,
      caption: 'スウェーデンヒルズの家並み',
      credit: '写真: 当別の写真家（CC BY-SA 4.0）',
      opacity: 1,
    })
    expect(scene.credit).toBe('紹介文: Wikipedia「当別町」（CC BY-SA 4.0）')
    expect(scene.waiting).toBe(false)
  })

  it('作者の無い画像（パブリック・ドメイン）は、ライセンスだけを出す', () => {
    const publicDomain: Playback = {
      ...withImage,
      intro: { status: 'ready', intro: { ...tobetsuIntroWithImage, image: { url: 'https://upload.wikimedia.org/lake.jpg', artist: '', license: 'Public domain', caption: '' } }, readyAt: STARTED_AT, narration: null },
    }

    expect(sceneAt(publicDomain, STARTED_AT + LANDING + 1).image?.credit).toBe('写真: Public domain')
  })

  it('画像を出し終えたら画像を消し、大見出しから流す', () => {
    const scene = sceneAt(withImage, STARTED_AT + LANDING + IMAGE_MS + 1)

    expect(scene.image).toBeNull()
    expect(scene.item?.line.kind).toBe('hook')
  })

  it('画像の場面のぶん、締めまでの時刻がずれる', () => {
    expect(tourSpanOf(withImage, readyOf(withImage)).end).toBe(tourSpanOf(readyPlayback(0), readyOf(readyPlayback(0))).end + IMAGE_MS)
  })

  it('出せる代表画像が無ければ、画像の場面を飛ばして着地から大見出しを流す', () => {
    const scene = sceneAt(readyPlayback(0), STARTED_AT + LANDING + 1)

    expect(scene.image).toBeNull()
    expect(scene.item?.line.kind).toBe('hook')
  })
})

describe('sceneAt の全国制覇マップ（issue #252）', () => {
  /** 振りを流し終える時刻（再生を始めてからのミリ秒）。ここから制覇マップを出す */
  const CONQUEST_START = MAP_START + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS
  const at = (ms: number) => sceneAt(readyPlayback(0), STARTED_AT + CONQUEST_START + ms)

  it('振りを流しているあいだは、制覇マップを出さない', () => {
    expect(at(-1).conquest).toBeNull()
  })

  it('振りを流し終えたら、紹介の場面を消し、日本全体へ引きながら、これまでの制覇数を出す', () => {
    const scene = at(CONQUEST_ZOOM_MS / 2)

    expect(scene).toMatchObject({ item: null, credit: '紹介文: Wikipedia「当別町」（CC BY-SA 4.0）', done: false })
    expect(scene.zoom).toBeGreaterThan(0)
    expect(scene.zoom).toBeLessThan(1)
    expect(scene.conquest).toMatchObject({ label: '制覇 1 / 1,747（0.1%）', stamp: 0 })
  })

  it('引ききったら日本全体を映す', () => {
    expect(at(CONQUEST_ZOOM_MS).zoom).toBe(0)
  })

  it('今回の市町村を数える時刻を過ぎたら、今回を数えた制覇数と節目の一文を出す', () => {
    const milestonePlayback: Playback = { ...readyPlayback(0), conquest: { ...tobetsuConquest, milestones: ['北海道に初上陸！'] } }
    const before = sceneAt(milestonePlayback, STARTED_AT + CONQUEST_START + CONQUEST_STAMP_MS - 1).conquest
    const after = sceneAt(milestonePlayback, STARTED_AT + CONQUEST_START + CONQUEST_STAMP_MS + 1000).conquest

    expect(before).toMatchObject({ label: '制覇 1 / 1,747（0.1%）', milestones: [] })
    expect(after).toMatchObject({ label: '制覇 2 / 1,747（0.1%）', milestones: ['北海道に初上陸！'], stamp: 1 })
  })

  it('認定証を出さない再生（キーワード）は、制覇マップを6秒出したら終わる', () => {
    const keywordPlayback: Playback = { ...readyPlayback(0), call: { ...tobetsuCall, visit: { occasion: 'keyword', userName: '山田花子' }, honoraryCitizen: null } }

    expect(sceneAt(keywordPlayback, STARTED_AT + CONQUEST_START + CONQUEST_MS - 1).done).toBe(false)
    expect(sceneAt(keywordPlayback, STARTED_AT + CONQUEST_START + CONQUEST_MS)).toMatchObject({ certificate: null, done: true })
  })
})

describe('sceneAt の名誉町民の認定証（issue #253）', () => {
  /** 制覇マップを出し終える時刻（再生を始めてからのミリ秒）。ここから認定証を出す */
  const CERTIFICATE_START = MAP_START + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS + CONQUEST_MS
  const at = (ms: number) => sceneAt(readyPlayback(0), STARTED_AT + CERTIFICATE_START + ms)

  it('制覇マップを出しているあいだは、認定証を出さない', () => {
    expect(at(-1).certificate).toBeNull()
  })

  it('制覇マップを出し終えたら、制覇マップの帯を消し、レイド元の名前を入れた認定証を出す。出典は出し続ける', () => {
    const scene = at(1000)

    expect(scene).toMatchObject({ conquest: null, credit: '紹介文: Wikipedia「当別町」（CC BY-SA 4.0）', done: false })
    expect(scene.certificate).toMatchObject({ title: '名誉町民証', holder: '山田花子 様', opacity: 1 })
  })

  it('認定証の日付は、再生を始めた日にする', () => {
    // STARTED_AT は 1970年1月1日（日本時間）
    expect(at(0).certificate?.date).toBe('昭和45年1月1日')
  })

  it('認定証を8秒出したら、終わる', () => {
    expect(at(CERTIFICATE_MS - 1).done).toBe(false)
    expect(at(CERTIFICATE_MS).done).toBe(true)
  })
})

describe('共通点の場面（issue #275）', () => {
  const bond = {
    raiderName: '山田花子',
    raiderIcon: 'https://static-cdn.jtvnw.net/yamada.png',
    raiderQuote: '花子',
    townQuote: '当別米',
    text: '花子さんと当別米。どちらも実りを待つ存在なのです。',
    certificateReason: '本町の当別米と同じく実りを待たれた功績につき',
  }
  const withBond = (): Playback => {
    const playback = readyPlayback(0)
    return { ...playback, intro: { ...readyOf(playback), intro: { ...tobetsuIntro, bond } } }
  }

  it('振りの代わりに共通点の場面を、振りより長い BOND_MS のあいだ流す', () => {
    const playback = withBond()

    expect(BOND_MS).toBe(12000)
    expect(tourSpanOf(playback, readyOf(playback)).segments.map(({ line, duration }) => [line.kind, duration])).toEqual([
      ['hook', HOOK_MS],
      ['point', POINT_MS],
      ['point', PUNCHLINE_MS],
      ['bond', BOND_MS],
    ])
  })

  it('認定証に、共通点と同じ任命理由を添える', () => {
    const certificateStart = MAP_START + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + BOND_MS + CONQUEST_MS

    expect(sceneAt(withBond(), STARTED_AT + certificateStart + 1000).certificate?.reason).toBe('本町の当別米と同じく実りを待たれた功績につき')
  })

  it('共通点の無い回の認定証は、任命理由を持たない', () => {
    const certificateStart = MAP_START + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS + CONQUEST_MS

    expect(sceneAt(readyPlayback(0), STARTED_AT + certificateStart + 1000).certificate?.reason).toBeNull()
  })
})

describe('visitRecordAtOf（issue #252）', () => {
  /** 振りを流し終える時刻（再生を始めてからのミリ秒） */
  const CONQUEST_START = MAP_START + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS

  it('流しきったら記録する紹介なら、振りを流し終えた時刻（制覇マップを出しはじめる時刻）を返す', () => {
    expect(visitRecordAtOf(readyPlayback(0))).toBe(CONQUEST_START)
  })

  it('試し再生（記録するきっかけが無い）なら、記録しないので null を返す', () => {
    expect(visitRecordAtOf({ ...readyPlayback(0), call: { ...tobetsuCall, visit: null } })).toBeNull()
  })

  it('紹介が届いていない・作れなかった再生は、流しきっていないので null を返す', () => {
    expect(visitRecordAtOf(loadingPlayback)).toBeNull()
    expect(visitRecordAtOf({ ...loadingPlayback, intro: { status: 'failed' } })).toBeNull()
  })
})

describe('ナレーション（issue #255）', () => {
  /** ズームが着地した時刻（再生を始めてからのミリ秒） */
  const LANDING = MAP_START + ZOOM_END_MS
  /** 読み上げた音声（url は合成ページが読み込んだ音声を指す。長さはミリ秒） */
  const clip = (duration: number) => ({ url: `blob:narration-${duration}`, duration })
  /** 紹介が始めた時点で届き、ナレーションを読み込み終えた再生 */
  const narrated = (narration: Narration, intro: TownTourIntro = tobetsuIntro): Playback => ({
    ...readyPlayback(0),
    call: { ...tobetsuCall, narration: true },
    intro: { status: 'ready', intro, readyAt: STARTED_AT, narration },
  })
  /** どの場面も決まった長さより短い読み上げ（大見出し・項目2つ・振り） */
  const shortLines = [clip(2000), clip(2000), clip(2000), clip(2000)]

  it('冒頭の一文を読み上げるあいだは、着地のまま項目を出さず、読み終えて余白を置いてから大見出しを流す', () => {
    const playback = narrated({ opening: clip(4000), lines: shortLines })
    const itemsStart = LANDING + 4000 + NARRATION_TAIL_MS

    expect(tourSpanOf(playback, readyOf(playback))).toMatchObject({ landing: LANDING, itemsStart })
    expect(sceneAt(playback, STARTED_AT + itemsStart - 1)).toMatchObject({ item: null, waiting: false })
    expect(sceneAt(playback, STARTED_AT + itemsStart + 1).item?.line.kind).toBe('hook')
  })

  it('代表画像があれば、冒頭の一文は画像を出しながら読み、画像の場面より長ければ読み終えるまで画像を出す', () => {
    const shorter = narrated({ opening: clip(2000), lines: shortLines }, tobetsuIntroWithImage)
    const longer = narrated({ opening: clip(IMAGE_MS + 1000), lines: shortLines }, tobetsuIntroWithImage)

    expect(tourSpanOf(shorter, readyOf(shorter)).itemsStart).toBe(LANDING + IMAGE_MS)
    expect(tourSpanOf(longer, readyOf(longer)).itemsStart).toBe(LANDING + IMAGE_MS + 1000 + NARRATION_TAIL_MS)
    expect(sceneAt(longer, STARTED_AT + LANDING + IMAGE_MS + 500).image).not.toBeNull()
  })

  it('読み上げが決まった長さに収まる場面は、決まった長さのまま流す', () => {
    const playback = narrated({ opening: null, lines: shortLines })

    expect(tourSpanOf(playback, readyOf(playback)).segments.map(({ duration }) => duration)).toEqual([HOOK_MS, POINT_MS, PUNCHLINE_MS, CUE_MS])
  })

  it('読み上げが決まった長さより長い場面は、読み上げの長さに余白を足した長さまで延ばす', () => {
    const playback = narrated({ opening: null, lines: [clip(2000), clip(9000), clip(2000), clip(2000)] })

    expect(tourSpanOf(playback, readyOf(playback)).segments.map(({ duration }) => duration)).toEqual([
      HOOK_MS,
      9000 + NARRATION_TAIL_MS,
      PUNCHLINE_MS,
      CUE_MS,
    ])
  })

  it('合成できなかった場面（null）は、文字だけを決まった長さで流す', () => {
    const playback = narrated({ opening: null, lines: [null, clip(9000), null, null] })

    expect(tourSpanOf(playback, readyOf(playback)).segments.map(({ duration }) => duration)).toEqual([
      HOOK_MS,
      9000 + NARRATION_TAIL_MS,
      PUNCHLINE_MS,
      CUE_MS,
    ])
  })

  it('場面ごとに、その場面で読み上げる音声を持つ（音の表が出だしで鳴らすため）', () => {
    const playback = narrated({ opening: clip(4000), lines: [null, clip(3000), clip(2500), clip(2000)] })
    const span = tourSpanOf(playback, readyOf(playback))

    expect(span.openingNarration).toEqual(clip(4000))
    expect(span.segments.map(({ narration }) => narration)).toEqual([null, clip(3000), clip(2500), clip(2000)])
  })
})
