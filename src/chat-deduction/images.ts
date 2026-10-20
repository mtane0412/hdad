/**
 * チャットで推理の解説に添える画像の読み取り
 *
 * 画像は問題ごとの Wikipedia の記事（problems.json の wikipedia）の代表画像で、scripts/chat-deduction/build-images.ts が
 * 画面に出す大きさの URL・作者・ライセンスを images.json に固めた生成物である（手で直さない）。配信中に Wikipedia へ
 * 問い合わせないので、どの画像が映るかを配信の前に確かめられる。出せる画像が無い問題（代表画像が無い・地図や紋章・
 * ライセンスが合わない）は null を持つ。
 *
 * 注意: 問題を足した・消したのに作り直していなければ、問題集との1対1が崩れるので投げる（Fail-Fast）。
 * 注意: Worker からも読み込むので、DOM や src/core/ のブラウザ向けの部品に頼らない。
 */
import type { ChatDeductionProblem } from './problems'

/** 解説に添える画像 */
export interface ChatDeductionImage {
  /** 画面に出す大きさの画像の URL（Wikimedia の画像） */
  readonly url: string
  /** 作者。作者の表記が要らないライセンス（パブリック・ドメイン・CC0）で作者が無ければ空文字 */
  readonly artist: string
  /** ライセンスの名前（「CC BY-SA 4.0」「Public domain」） */
  readonly license: string
}

/** 画像の URL の置き場（Wikimedia の画像の置き場 upload・thumb などだけを https で許す） */
const IMAGE_HOST_SUFFIX = '.wikimedia.org'

/** Wikimedia の画像の置き場を指す https の URL か */
const isWikimediaUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false
  const { protocol, hostname } = new URL(value)
  return protocol === 'https:' && hostname.endsWith(IMAGE_HOST_SUFFIX)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isImage = (value: unknown): value is ChatDeductionImage =>
  isRecord(value) &&
  typeof value.url === 'string' &&
  isWikimediaUrl(value.url) &&
  typeof value.artist === 'string' &&
  typeof value.license === 'string' &&
  value.license !== ''

/**
 * images.json の中身を、問題のIDから画像を引く表として読む。
 *
 * @param problems 問題集のすべての問題（1対1を確かめる）
 * @throws オブジェクトでない・問題集との1対1が崩れている・画像の形が違う場合
 */
export const readChatDeductionImages = (value: unknown, problems: readonly ChatDeductionProblem[]): ReadonlyMap<string, ChatDeductionImage | null> => {
  if (!isRecord(value)) throw new Error('チャットで推理の画像（images.json）はオブジェクトにしてください')
  const problemIds = new Set(problems.map((problem) => problem.id))
  for (const id of Object.keys(value)) {
    if (!problemIds.has(id)) throw new Error(`チャットで推理の画像（images.json）に、問題集に無い問題（${id}）があります。npm run build:chat-deduction-images で作り直してください`)
  }
  return new Map(
    problems.map((problem): [string, ChatDeductionImage | null] => {
      if (!(problem.id in value)) throw new Error(`チャットで推理の画像（images.json）に問題（${problem.id}）がありません。npm run build:chat-deduction-images で作り直してください`)
      const image = value[problem.id]
      if (image !== null && !isImage(image)) throw new Error(`チャットで推理の画像（images.json）の問題（${problem.id}）の形が違います`)
      return [problem.id, image]
    }),
  )
}
