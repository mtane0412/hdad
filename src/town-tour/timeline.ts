/**
 * 市町村紹介の再生の進み方
 *
 * 1件の再生の場面（ズームの進み具合・塗りの濃さ・流している項目・出典）を、再生を始めた時刻・紹介が届いた時刻と
 * 現在時刻だけから決める（.claude/CLAUDE.md の「描画とパラメータ」。フレーム間の状態を持たない）。
 *
 * 流れは次のとおり。
 * 1. 日本全体を映す（JAPAN_HOLD_MS）
 * 2. 市町村へズームしながら、形を塗る（ZOOM_MS）
 * 3. 紹介の項目を1つずつ流す（1項目 ITEM_MS）。紹介は受け取ってから作らせる（2〜5秒）ので、ズームが終わっても
 *    届いていなければ、届くまで待ってから始める
 * 4. 出典だけを残して（CREDIT_HOLD_MS）、薄くして終わる
 *
 * 紹介を作れなかった再生はその場で終わる。失敗は素材の箱に出す（合成ページの stage.ts が受け持つ）。
 */
import { tourItemsOf, type TourLine, type TownTourCall, type TownTourIntro } from './tour'

/** 日本全体を映しておく時間（ミリ秒） */
const JAPAN_HOLD_MS = 1500
/** 市町村へズームする時間（ミリ秒） */
const ZOOM_MS = 3000
/** ズームが終わる時刻（再生を始めてからのミリ秒）。ここから項目を流せる */
export const ZOOM_END_MS = JAPAN_HOLD_MS + ZOOM_MS
/** 市町村の形を塗りはじめる時刻（再生を始めてからのミリ秒）。ズームの後半で、市町村が見分けられる大きさになってから塗る */
const FILL_START_MS = 3000
/** 1項目を流す時間（ミリ秒）。配信者が決めた長さ（issue #229） */
export const ITEM_MS = 6000
/** 項目の出入りで薄くする時間（ミリ秒） */
const ITEM_FADE_MS = 400
/** 項目を流し終えてから、出典だけを残しておく時間（ミリ秒） */
const CREDIT_HOLD_MS = 4000
/** 冒頭の一文を出しきるまでの時間（ミリ秒） */
const HEADLINE_FADE_MS = 500
/** 終わりに全体を薄くする時間（ミリ秒） */
const FADE_OUT_MS = 600

/** 紹介の届き具合 */
export type IntroState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly intro: TownTourIntro; readonly readyAt: number }
  | { readonly status: 'failed' }

/** 1件の再生 */
export interface Playback {
  readonly call: TownTourCall
  /** 再生を始めた時刻（ミリ秒。Date.now() と同じ基準） */
  readonly startedAt: number
  readonly intro: IntroState
}

/** ある時刻の場面 */
export interface Scene {
  /** ズームの進み具合（0 で日本全体、1 で市町村。緩急を付けたもの） */
  readonly zoom: number
  /** 市町村の形の塗りの濃さ（0〜1） */
  readonly fill: number
  /** 冒頭の一文の濃さ（0〜1） */
  readonly headline: number
  /** 流している項目と、その濃さ（0〜1）。流していなければ null */
  readonly item: { readonly line: TourLine; readonly opacity: number } | null
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

/**
 * 再生の now での場面を決める。
 *
 * @param now 現在時刻（ミリ秒。Date.now() と同じ基準）
 */
export const sceneAt = (playback: Playback, now: number): Scene => {
  const elapsed = now - playback.startedAt
  const { intro } = playback
  const base = {
    zoom: easeInOut(clamp01((elapsed - JAPAN_HOLD_MS) / ZOOM_MS)),
    fill: clamp01((elapsed - FILL_START_MS) / (ZOOM_END_MS - FILL_START_MS)),
    headline: clamp01(elapsed / HEADLINE_FADE_MS),
  }

  if (intro.status === 'failed') return { ...base, item: null, credit: null, waiting: false, opacity: 0, done: true }
  if (intro.status === 'loading') return { ...base, item: null, credit: null, waiting: elapsed >= ZOOM_END_MS, opacity: 1, done: false }

  // 項目はズームが終わってから、紹介が届くのが遅ければ届いてから流しはじめる
  const lines = tourItemsOf(intro.intro.tour)
  const itemsStart = Math.max(ZOOM_END_MS, intro.readyAt - playback.startedAt)
  const end = itemsStart + lines.length * ITEM_MS + CREDIT_HOLD_MS
  const sinceItems = elapsed - itemsStart
  const line = sinceItems < 0 ? undefined : lines[Math.floor(sinceItems / ITEM_MS)]

  return {
    ...base,
    item: line === undefined ? null : { line, opacity: fadeWithin(sinceItems % ITEM_MS, ITEM_MS, ITEM_FADE_MS) },
    credit: sinceItems < 0 ? null : creditOf(intro.intro),
    waiting: elapsed >= ZOOM_END_MS && sinceItems < 0,
    opacity: clamp01((end - elapsed) / FADE_OUT_MS),
    done: elapsed >= end,
  }
}
