/**
 * 市町村紹介の冒頭の都道府県当てクイズ（issue #251）
 *
 * 紹介の冒頭で市町村の形だけをシルエットで出し、「どこの都道府県でしょう？」とチャットに問う。
 * ここはクイズの決まりごと（待つ長さ・ヒントを出す間隔）と、通信を持たない判断だけを置く。
 * - チャットの発言から、答えた都道府県を1つだけ読み取る（answeredPrefectureOf。Worker が Webhook で受けた発言に使う）
 * - 市町村のコードの上2桁から都道府県を引く（prefectureOfCode）
 * - ヒントの文を作る（quizHintsOf。海に面しているか・隣り合う都道府県は、合成ページが地図の形から求めて渡す。topo.ts の decodeTownBorders）
 *
 * Worker（判定と、出題を受け付ける長さ）と合成ページ（場面の長さ）が同じ長さを使うため、ここに置いて両方から読む
 * （Worker から src/ を読み込む例外。.claude/rules/town-tour.md）。
 *
 * 注意: 通信も DOM も持ち込まない（Worker からも読むため）。
 */
import type { TownBorders } from './topo'

/** 回答を待つ長さ（ミリ秒）。配信者が決めた（issue #251） */
export const QUIZ_MS = 15_000

/** ヒントを1つずつ足していく間隔（ミリ秒）。出題から QUIZ_HINT_INTERVAL_MS ごとに1つ増える */
export const QUIZ_HINT_INTERVAL_MS = 4000

/** クイズの場面に添える見出し */
export const QUIZ_LABEL = '都道府県当てクイズ'

/** クイズの問い。市町村の名前は出す（都道府県だけを伏せる。配信者が決めた） */
export const quizQuestionOf = (townName: string): string => `${townName}はどこの都道府県でしょう？ チャットで答えてね`

/** 正解の場面の見出し。最初の正解者がいればその名前、いなければ時間切れ */
export const revealLabelOf = (winner: string | null): string => (winner === null ? '時間切れ！' : `最初の正解: ${winner}さん`)

/** 正解の場面の文 */
export const revealTextOf = (prefecture: string): string => `正解は${prefecture}`

/** 都道府県の名前。並びは全国地方公共団体コードの上2桁の順（北海道が01、沖縄県が47） */
const PREFECTURES = [
  '北海道',
  '青森県',
  '岩手県',
  '宮城県',
  '秋田県',
  '山形県',
  '福島県',
  '茨城県',
  '栃木県',
  '群馬県',
  '埼玉県',
  '千葉県',
  '東京都',
  '神奈川県',
  '新潟県',
  '富山県',
  '石川県',
  '福井県',
  '山梨県',
  '長野県',
  '岐阜県',
  '静岡県',
  '愛知県',
  '三重県',
  '滋賀県',
  '京都府',
  '大阪府',
  '兵庫県',
  '奈良県',
  '和歌山県',
  '鳥取県',
  '島根県',
  '岡山県',
  '広島県',
  '山口県',
  '徳島県',
  '香川県',
  '愛媛県',
  '高知県',
  '福岡県',
  '佐賀県',
  '長崎県',
  '熊本県',
  '大分県',
  '宮崎県',
  '鹿児島県',
  '沖縄県',
] as const

/** 地方（八地方区分）ごとの、最後の都道府県の番号（コードの上2桁）。番号の順に並んでいるので、区切りだけで引ける */
const REGIONS: readonly { readonly name: string; readonly lastNumber: number }[] = [
  { name: '北海道', lastNumber: 1 },
  { name: '東北', lastNumber: 7 },
  { name: '関東', lastNumber: 14 },
  { name: '中部', lastNumber: 23 },
  { name: '近畿', lastNumber: 30 },
  { name: '中国', lastNumber: 35 },
  { name: '四国', lastNumber: 39 },
  { name: '九州・沖縄', lastNumber: 47 },
]

/** 名前の末尾の「都・府・県」。北海道の「道」は省くと「北海」になって通じないので省かない */
const SUFFIX_PATTERN = /[都府県]$/

/** チャットに書かれうる書き方と、それが指す都道府県。長い書き方を先に照らすため、長さの降順に並べておく */
const SPELLINGS: readonly { readonly text: string; readonly prefecture: string }[] = PREFECTURES.flatMap((prefecture) => {
  const short = prefecture.replace(SUFFIX_PATTERN, '')
  return short === prefecture ? [{ text: prefecture, prefecture }] : [{ text: prefecture, prefecture }, { text: short, prefecture }]
}).sort((a, b) => b.text.length - a.text.length)

/**
 * チャットの発言から、答えた都道府県を読み取る。
 *
 * 発言を先頭から見ていき、それぞれの位置でいちばん長く当てはまる書き方を取って、その分だけ先へ進む。
 * こうすると「東京都」は「東京都」として読まれ、中の「京都」を京都府と読まない。
 *
 * @returns 答えた都道府県（正式な名前）。都道府県が書かれていない・2つ以上の都道府県を挙げた発言は null（回答とみなさない）
 */
export const answeredPrefectureOf = (text: string): string | null => {
  const found = new Set<string>()
  let index = 0
  while (index < text.length) {
    const spelling = SPELLINGS.find((candidate) => text.startsWith(candidate.text, index))
    if (spelling === undefined) {
      index += 1
      continue
    }
    found.add(spelling.prefecture)
    index += spelling.text.length
  }
  const [only] = found
  return found.size === 1 && only !== undefined ? only : null
}

/** 市町村のコードの上2桁（都道府県の番号） */
const prefectureNumberOf = (code: string): number => Number(code.slice(0, 2))

/**
 * 市町村のコード（全国地方公共団体コードの5桁）から都道府県を引く。
 *
 * @throws 上2桁が都道府県の番号（01〜47）でない場合
 */
export const prefectureOfCode = (code: string): string => {
  const prefecture = PREFECTURES[prefectureNumberOf(code) - 1]
  if (prefecture === undefined) throw new Error(`都道府県の番号でないコードです: ${code}`)
  return prefecture
}

/**
 * 都道府県の地方（八地方区分）を引く。
 *
 * @throws 都道府県の名前でない場合
 */
const regionOf = (prefecture: string): string => {
  const number = PREFECTURES.findIndex((candidate) => candidate === prefecture) + 1
  const region = REGIONS.find(({ lastNumber }) => number >= 1 && number <= lastNumber)
  if (region === undefined) throw new Error(`都道府県の名前ではありません: ${prefecture}`)
  return region.name
}

/** ヒントの材料。海に面しているかと隣り合う都道府県は、合成ページが地図の形から求める（topo.ts の decodeTownBorders） */
export interface QuizClue {
  /** 正解の都道府県 */
  readonly prefecture: string
  /** 出題した市町村が海に面しているか */
  readonly coastal: boolean
  /** 正解の都道府県と陸で接する都道府県 */
  readonly neighbors: readonly string[]
}

/**
 * 出題する市町村のヒントの材料を、地図の境界の分け合い方から求める。
 *
 * 隣り合う都道府県は、正解の都道府県の市町村と境界を分け合う市町村の都道府県を、コードの順に並べたものにする。
 *
 * @param borders 同梱の日本地図から求めた境界（topo.ts の decodeTownBorders）
 * @throws コードの上2桁が都道府県の番号でない場合
 */
export const quizClueOf = (code: string, borders: TownBorders): QuizClue => {
  const prefecture = prefectureOfCode(code)
  const neighborNumbers = new Set<number>()
  for (const [town, others] of borders.adjacent) {
    if (prefectureOfCode(town) !== prefecture) continue
    for (const other of others) {
      if (prefectureOfCode(other) !== prefecture) neighborNumbers.add(prefectureNumberOf(other))
    }
  }
  return {
    prefecture,
    coastal: borders.coastal.has(code),
    neighbors: [...neighborNumbers].sort((a, b) => a - b).map((number) => prefectureOfCode(String(number).padStart(2, '0'))),
  }
}

/**
 * 出す順に並べたヒントの文を作る（海に面しているか → 地方 → 隣り合う都道府県。あとのものほど答えに近い）。
 *
 * @throws 正解が都道府県の名前でない場合
 */
export const quizHintsOf = ({ prefecture, coastal, neighbors }: QuizClue): string[] => [
  coastal ? '海に面しています' : '海に面していません',
  `${regionOf(prefecture)}地方にあります`,
  neighbors.length === 0 ? '陸で接する都道府県はありません' : `隣り合う都道府県: ${neighbors.join('・')}`,
]
