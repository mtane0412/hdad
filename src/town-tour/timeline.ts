/**
 * 市町村紹介の再生の進み方
 *
 * 1件の再生の場面（ズームの進み具合・塗りの濃さ・流している項目・出典）を、再生を始めた時刻・紹介が届いた時刻と
 * 現在時刻だけから決める（.claude/CLAUDE.md の「描画とパラメータ」。フレーム間の状態を持たない）。
 *
 * 流れは次のとおり。
 * 0. 市町村の形だけをシルエットで出し、都道府県当てクイズを出す（QUIZ_MS。QUIZ_HINT_INTERVAL_MS ごとにヒントを1つ足す。issue #251）。
 *    チャットで最初の正解者が届いたら、その時点でクイズを終える。終えたら正解（と最初の正解者）を出す（REVEAL_MS）
 * 1. クイズを終えたら、日本全体を映す（JAPAN_HOLD_MS）。ここから先の時刻は、どれもクイズを終えた時刻から数える
 * 2. 市町村へズームしながら、形を塗る（ZOOM_MS）
 * 3. 記事に出せる代表画像があれば、まず画像を作者とライセンスと一緒に出す（IMAGE_MS。issue #254）。無ければ飛ばす。
 *    紹介は受け取ってから作らせる（2〜5秒）ので、ズームが終わっても届いていなければ、届くまで待ってから始める
 * 4. 紹介の場面を順に流す。大見出し（HOOK_MS。前半 HOOK_TEASE_MS は見出し「この町、実は…」だけで溜める）→
 *    ゆさぶりの項目（POINT_MS ずつ）→ オチ（最後の項目。PUNCHLINE_MS）→ 配信者への振り（CUE_MS）。長さは配信者が決めた（issue #249）。
 * 5. 日本全体へ引きながら、これまでに紹介した市町村を塗った全国制覇マップと制覇数を出す（CONQUEST_MS。issue #252）。
 *    引ききった後（CONQUEST_STAMP_MS）に今回の市町村を数えた制覇数と節目の一文に替える
 * 6. 名誉町民にする相手がいれば（レイドと試し再生）、認定証を出す（CERTIFICATE_MS。issue #253）。いなければ（キーワード）制覇マップで終える。
 *    最後は薄くして終わる。出典は終わりまで出し続ける
 *
 * 紹介を作れなかった再生はその場で終わる。失敗は素材の箱に出す（合成ページの stage.ts が受け持つ）。
 */
import { QUIZ_HINT_INTERVAL_MS, QUIZ_LABEL, QUIZ_MS, QUIZ_UNOPENED_LABEL, quizQuestionOf, revealLabelOf, revealTextOf } from './quiz'
import { certificateOf, type Certificate } from './certificate'
import { conquestLabelOf, type Conquest } from './conquest'
import { tourLinesOf, type TourLine, type TownTourCall, type TownTourIntro } from './tour'

/** クイズを終えてから、正解（と最初の正解者）を出しておく時間（ミリ秒）。日本全体を映し、寄り始めるところまで重ねる */
export const REVEAL_MS = 3000
/** 日本全体を映しておく時間（ミリ秒。クイズを終えてから）。ここから市町村へ寄り始める */
export const JAPAN_HOLD_MS = 1500
/** 市町村へズームする時間（ミリ秒） */
const ZOOM_MS = 3000
/** ズームが終わる時刻（クイズを終えてからのミリ秒）。ここから項目を流せる */
export const ZOOM_END_MS = JAPAN_HOLD_MS + ZOOM_MS
/** 市町村の形を塗りはじめる時刻（クイズを終えてからのミリ秒）。ズームの後半で、市町村が見分けられる大きさになってから塗る */
const FILL_START_MS = 3000
/** 代表画像を出しておく時間（ミリ秒）。ズームの着地から数える。写真を眺める間として、項目と同じ長さにする（issue #254） */
export const IMAGE_MS = 6000
/** 大見出しを流す時間（ミリ秒）。溜めて長くする */
export const HOOK_MS = 7000
/** 大見出しの前半で、文を伏せて見出し（「この町、実は…」）だけを出しておく時間（ミリ秒） */
export const HOOK_TEASE_MS = 1500
/** ゆさぶりの項目（最後でない項目）を流す時間（ミリ秒） */
export const POINT_MS = 6000
/** オチ（最後の項目）を流す時間（ミリ秒）。短く切る */
export const PUNCHLINE_MS = 5000
/** 配信者への振りを流す時間（ミリ秒）。配信者がリアクションする間 */
export const CUE_MS = 6000
/** 場面の出入りで薄くする時間（ミリ秒） */
const ITEM_FADE_MS = 400
/** 全国制覇マップを出しておく時間（ミリ秒）。振りを流し終えてから数え、これが過ぎたら再生を終える。長さは配信者が決めた（issue #252） */
export const CONQUEST_MS = 6000
/** 全国制覇マップで、日本全体へ引く時間（ミリ秒） */
export const CONQUEST_ZOOM_MS = 1500
/** 全国制覇マップで、今回の市町村を数える時刻（制覇マップを出しはじめてからのミリ秒）。引ききって一呼吸おいてから、塗りを1つ増やす */
export const CONQUEST_STAMP_MS = 2500
/** 名誉町民の認定証を出しておく時間（ミリ秒）。制覇マップを出し終えてから数える。文面を読み、スクリーンショットを撮れる長さとして配信者が決めた（issue #253） */
export const CERTIFICATE_MS = 8000
/** 冒頭の一文を出しきるまでの時間（ミリ秒） */
const HEADLINE_FADE_MS = 500
/** 終わりに全体を薄くする時間（ミリ秒） */
export const FADE_OUT_MS = 600

/** 紹介の届き具合 */
export type IntroState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly intro: TownTourIntro; readonly readyAt: number }
  | { readonly status: 'failed' }

/** 冒頭の都道府県当てクイズの状態 */
export interface QuizState {
  /** 出す順に並べたヒントの文（quiz.ts の quizHintsOf） */
  readonly hints: readonly string[]
  /** 最初の正解者と、それを受け取った時刻（ミリ秒。Date.now() と同じ基準）。まだ届いていなければ null */
  readonly answer: { readonly userName: string; readonly answeredAt: number } | null
  /** 出題を開けなかった（Worker に断られた・届かなかった）時刻。開けていれば null。答えても届かない問いを出し続けないよう、ここで打ち切る */
  readonly unopenedAt: number | null
}

/** 1件の再生 */
export interface Playback {
  readonly call: TownTourCall
  /** 再生を始めた時刻（ミリ秒。Date.now() と同じ基準） */
  readonly startedAt: number
  readonly intro: IntroState
  readonly quiz: QuizState
  /** 締めに出す全国制覇マップ（conquest.ts の conquestOf。地図の境界が要るので、流しはじめるときに決めておく） */
  readonly conquest: Conquest
}

/** ある時刻の場面 */
export interface Scene {
  /** ズームの進み具合（0 で日本全体、1 で市町村。緩急を付けたもの） */
  readonly zoom: number
  /** 市町村の形の塗りの濃さ（0〜1） */
  readonly fill: number
  /** 冒頭の一文の濃さ（0〜1） */
  readonly headline: number
  /** 冒頭の一文。クイズのあいだは都道府県を伏せたもの、終えたら都道府県入りのもの */
  readonly headlineText: string
  /** 出しているクイズ（見出し・問い・ここまでに出したヒント）。クイズを終えたら null */
  readonly quiz: { readonly label: string; readonly question: string; readonly hints: readonly string[] } | null
  /** 出している正解の場面と、その濃さ（0〜1）。出していなければ null */
  readonly reveal: { readonly label: string; readonly text: string; readonly opacity: number } | null
  /** 出している代表画像の URL・作者とライセンスの表記・濃さ（0〜1）。出していなければ null（issue #254） */
  readonly image: { readonly url: string; readonly credit: string; readonly opacity: number } | null
  /** 流している場面と、その濃さ（0〜1）・文の濃さ（0〜1。大見出しの溜めのあいだは 0）。流していなければ null */
  readonly item: { readonly line: TourLine; readonly opacity: number; readonly textOpacity: number } | null
  /**
   * 出している全国制覇マップ。出していなければ null。
   * label は制覇数の表記、milestones は節目の一文（今回を数えるまでは空）、opacity は出しはじめの濃さ（0〜1）、
   * stamp は今回の市町村を数えたことを示す強調の濃さ（0〜1。数えるまでは 0）
   */
  readonly conquest: {
    readonly label: string
    readonly milestones: readonly string[]
    readonly opacity: number
    readonly stamp: number
  } | null
  /** 出している名誉町民の認定証の文面と、その濃さ（0〜1）。出していなければ null */
  readonly certificate: (Certificate & { readonly opacity: number }) | null
  /** 出典の表記。紹介が届くまでは null */
  readonly credit: string | null
  /** ズームを終えて、紹介が届くのを待っているか */
  readonly waiting: boolean
  /** 全体の濃さ（0〜1）。終わりに薄くする */
  readonly opacity: number
  /** 再生を終えたか（次の再生へ進んでよい） */
  readonly done: boolean
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** 動きの始まりと終わりをゆっくりにする緩急（3次） */
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)

/** 長さ duration の区間の中の elapsed での濃さ。出入りの fade ミリ秒で薄くする */
const fadeWithin = (elapsed: number, duration: number, fade: number): number => clamp01(Math.min(elapsed / fade, (duration - elapsed) / fade))

/** 出典の表記（Wikipedia の本文は CC BY-SA 4.0） */
const creditOf = (intro: TownTourIntro): string => `出典: Wikipedia「${intro.article.title}」（CC BY-SA 4.0）`

/** 代表画像の作者とライセンスの表記。作者の無い画像（パブリック・ドメイン・CC0）はライセンスだけにする */
const imageCreditOf = ({ artist, license }: NonNullable<TownTourIntro['image']>): string =>
  artist === '' ? `写真: ${license}` : `写真: ${artist}（${license}）`

/** 流す1場面と、その時刻（再生を始めてからのミリ秒） */
export interface TourSegment {
  readonly line: TourLine
  readonly start: number
  readonly duration: number
}

/**
 * クイズを終える時刻（再生を始めてからのミリ秒）。地図の演出はここから始まる。
 * クイズの長さのうちに最初の正解者が届いたか、出題を開けなかったならその時刻、どちらでもなければクイズの長さいっぱい。
 */
export const quizEndOf = ({ startedAt, quiz }: Playback): number => {
  const answeredAfter = quiz.answer === null ? QUIZ_MS : quiz.answer.answeredAt - startedAt
  const unopenedAfter = quiz.unopenedAt === null ? QUIZ_MS : quiz.unopenedAt - startedAt
  return Math.min(QUIZ_MS, Math.max(0, Math.min(answeredAfter, unopenedAfter)))
}

/** 正解の場面の見出し。最初の正解者・出題を開けなかった・時間切れの順に見る */
const revealLabelFor = ({ startedAt, quiz }: Playback, quizEnd: number): string => {
  if (quiz.answer !== null && quiz.answer.answeredAt - startedAt <= quizEnd && quizEnd < QUIZ_MS) return revealLabelOf(quiz.answer.userName)
  if (quiz.unopenedAt !== null && quiz.unopenedAt - startedAt <= quizEnd && quizEnd < QUIZ_MS) return QUIZ_UNOPENED_LABEL
  return revealLabelOf(null)
}

/** 紹介が届いた再生の流れ。時刻はどれも再生を始めてからのミリ秒 */
export interface TourSpan {
  /** 紹介を出しはじめる時刻（代表画像があれば画像、無ければ場面）。クイズとズームが終わってから、紹介が届くのが遅ければ届いてから */
  readonly landing: number
  /** 流す場面（大見出し・項目・振り）を順に並べたもの */
  readonly segments: readonly TourSegment[]
  /** 場面を流しはじめる時刻。代表画像があれば、画像を出し終えてから */
  readonly itemsStart: number
  /** 場面を流し終え、全国制覇マップを出しはじめる時刻 */
  readonly itemsEnd: number
  /** 全国制覇マップを出し終える時刻。認定証を出す再生では、ここから認定証を出す */
  readonly conquestEnd: number
  /** 再生を終える時刻 */
  readonly end: number
}

/** 場面の長さ。項目は最後のもの（オチ）だけを短くする */
const durationOf = (line: TourLine, isLastPoint: boolean): number => {
  if (line.kind === 'hook') return HOOK_MS
  if (line.kind === 'cue') return CUE_MS
  return isLastPoint ? PUNCHLINE_MS : POINT_MS
}

/**
 * 紹介が届いた再生の流れを決める。場面（sceneAt）と鳴らす音の表（sound-cues.ts）が同じ時刻を使うためにまとめてある。
 *
 * @param readyAt 紹介が届いた時刻（ミリ秒。Date.now() と同じ基準）
 */
export const tourSpanOf = (playback: Playback, intro: TownTourIntro, readyAt: number): TourSpan => {
  const lines = tourLinesOf(intro.tour, playback.call.name)
  const lastPointIndex = lines.map((line) => line.kind).lastIndexOf('point')
  const landing = Math.max(quizEndOf(playback) + ZOOM_END_MS, readyAt - playback.startedAt)
  const itemsStart = landing + (intro.image === null ? 0 : IMAGE_MS)
  const segments: TourSegment[] = []
  let cursor = itemsStart
  lines.forEach((line, index) => {
    const duration = durationOf(line, index === lastPointIndex)
    segments.push({ line, start: cursor, duration })
    cursor += duration
  })
  const conquestEnd = cursor + CONQUEST_MS
  const certificateDuration = playback.call.honoraryCitizen === null ? 0 : CERTIFICATE_MS
  return { landing, segments, itemsStart, itemsEnd: cursor, conquestEnd, end: conquestEnd + certificateDuration }
}

/**
 * 紹介した市町村として記録する時刻（再生を始めてからのミリ秒）。振りを流し終えた（流しきった）ときで、制覇マップを出しはじめる時刻と同じ。
 * 記録しない再生（試し再生）と、流しきっていない再生（紹介が届いていない・作れなかった）は null（issue #252）。
 */
export const visitRecordAtOf = (playback: Playback): number | null => {
  const { intro, call } = playback
  if (call.visit === null || intro.status !== 'ready') return null
  return tourSpanOf(playback, intro.intro, intro.readyAt).itemsEnd
}

/** 流している場面の、始まってから sinceStart ミリ秒での濃さ。大見出しは溜めのあいだ文を伏せ、溜めが終わったら文を出す */
const itemSceneOf = ({ line, duration }: TourSegment, sinceStart: number): NonNullable<Scene['item']> => ({
  line,
  opacity: fadeWithin(sinceStart, duration, ITEM_FADE_MS),
  textOpacity: line.kind === 'hook' ? clamp01((sinceStart - HOOK_TEASE_MS) / ITEM_FADE_MS) : 1,
})

/** 全国制覇マップを出しはじめてから sinceStart ミリ秒での、制覇マップの場面。今回の市町村を数える時刻で、制覇数と節目を替える */
const conquestSceneOf = ({ before, after, total, milestones }: Conquest, sinceStart: number): NonNullable<Scene['conquest']> => {
  const stamped = sinceStart >= CONQUEST_STAMP_MS
  return {
    label: conquestLabelOf(stamped ? after : before, total),
    milestones: stamped ? milestones : [],
    opacity: clamp01(sinceStart / ITEM_FADE_MS),
    stamp: clamp01((sinceStart - CONQUEST_STAMP_MS) / ITEM_FADE_MS),
  }
}

/**
 * 再生の now での場面を決める。
 *
 * @param now 現在時刻（ミリ秒。Date.now() と同じ基準）
 */
export const sceneAt = (playback: Playback, now: number): Scene => {
  const elapsed = now - playback.startedAt
  const { intro, call, quiz } = playback
  const quizEnd = quizEndOf(playback)
  /** クイズを終えてからの経過時間。地図の演出はこれで決める */
  const sinceQuiz = elapsed - quizEnd
  const inQuiz = sinceQuiz < 0
  const base = {
    zoom: easeInOut(clamp01((sinceQuiz - JAPAN_HOLD_MS) / ZOOM_MS)),
    fill: clamp01((sinceQuiz - FILL_START_MS) / (ZOOM_END_MS - FILL_START_MS)),
    headline: clamp01(elapsed / HEADLINE_FADE_MS),
    headlineText: inQuiz ? call.quizHeadline : call.headline,
    quiz: inQuiz
      ? { label: QUIZ_LABEL, question: quizQuestionOf(call.name), hints: quiz.hints.slice(0, Math.floor(elapsed / QUIZ_HINT_INTERVAL_MS)) }
      : null,
    reveal:
      inQuiz || sinceQuiz >= REVEAL_MS
        ? null
        : { label: revealLabelFor(playback, quizEnd), text: revealTextOf(call.prefecture), opacity: fadeWithin(sinceQuiz, REVEAL_MS, ITEM_FADE_MS) },
  }
  const waiting = sinceQuiz >= ZOOM_END_MS

  const hidden = { image: null, item: null, conquest: null, certificate: null, credit: null }
  if (intro.status === 'failed') return { ...base, ...hidden, waiting: false, opacity: 0, done: true }
  if (intro.status === 'loading') return { ...base, ...hidden, waiting, opacity: 1, done: false }

  const { landing, segments, itemsStart, itemsEnd, conquestEnd, end } = tourSpanOf(playback, intro.intro, intro.readyAt)
  /** 紹介を出しはじめてからの経過時間。負ならまだ出さない */
  const sinceLanding = elapsed - landing
  const { image } = intro.intro
  const segment = segments.find(({ start, duration }) => start <= elapsed && elapsed < start + duration)
  /** 全国制覇マップを出しはじめてからの経過時間。負ならまだ出さない */
  const sinceConquest = elapsed - itemsEnd
  /** 認定証を出しはじめてからの経過時間。負ならまだ出さない */
  const sinceCertificate = elapsed - conquestEnd
  const certificate = sinceCertificate < 0 ? null : certificateOf(call, playback.startedAt)

  return {
    ...base,
    // 全国制覇マップのあいだは、寄っていた市町村から日本全体へ引く
    zoom: sinceConquest < 0 ? base.zoom : 1 - easeInOut(clamp01(sinceConquest / CONQUEST_ZOOM_MS)),
    image:
      image === null || sinceLanding < 0 || elapsed >= itemsStart
        ? null
        : { url: image.url, credit: imageCreditOf(image), opacity: fadeWithin(sinceLanding, itemsStart - landing, ITEM_FADE_MS) },
    item: segment === undefined ? null : itemSceneOf(segment, elapsed - segment.start),
    conquest: sinceConquest < 0 || sinceCertificate >= 0 ? null : conquestSceneOf(playback.conquest, sinceConquest),
    certificate: certificate === null ? null : { ...certificate, opacity: clamp01(sinceCertificate / ITEM_FADE_MS) },
    credit: sinceLanding < 0 ? null : creditOf(intro.intro),
    waiting: waiting && sinceLanding < 0,
    opacity: clamp01((end - elapsed) / FADE_OUT_MS),
    done: elapsed >= end,
  }
}
