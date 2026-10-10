/**
 * 意見ボードの形と検証（issue #306）
 *
 * 意見ボードは、配信者が出したテーマについて視聴者がチャットに書いたコメントから意見を取り出し、観点（論点）ごとに並べて
 * 合成ページの素材「意見ボード」（素材の種類 opinions）に映す機能である（dd2030 のいどばたビジョンにならう）。
 * 多数決に見せないことを優先し、合成ページへは人数を出さない。意見は賛否ではなく札の種類（課題・解決策・問い・気づき）で区別する。
 *
 * ここには通信も時刻の取得も持たない純粋な関数だけを置く。
 * - テーマの検証（parseThemeInput）
 * - コメントを規則で落とすかの判定（dropReasonOf）。LLM に渡す前に、コマンド・エモートだけ・短い反応を落とす
 * - 保留中のコメントを、LLM に渡す発言にまとめる（readyUtterances）。同じ人が短い間隔で続けて書いたものは1つにつなげる
 * - 合成ページと管理画面へ渡す形（OpinionBoardSnapshot・AdminOpinionBoard）
 * - 配信者が救い出して作る意見と、論点の名前の検証（parseRescuedOpinionInput・parseTopicTitleInput。issue #308）
 * - 選んだ論点が、いまの論点と食い違わないかの判定（topicChoiceProblem。issue #308）
 *
 * 読み書きは worker/opinion-store.ts、Jev での絞り込みは worker/opinion-filter.ts、LLM での振り分けは worker/opinion-sort.ts、
 * 問いかけ（観点の提案）は worker/opinion-prompt.ts、経路は worker/opinion-routes.ts が持つ。
 *
 * 注意: テーマが上限を超えたら、切り詰めずに受け付けない（方針4）。
 */
import { ConfigError } from './alert-config'

/** 意見の札の種類。issue は課題、solution は解決策、question は問い、insight は気づき */
export const OPINION_KINDS = ['issue', 'solution', 'question', 'insight'] as const
export type OpinionKind = (typeof OPINION_KINDS)[number]

/** 札の種類ごとの呼び名。LLM への指示と応答もこの呼び名で読み書きする（src/opinions/entry.ts と合わせる） */
export const OPINION_KIND_LABELS: Readonly<Record<OpinionKind, string>> = {
  issue: '課題',
  solution: '解決策',
  question: '問い',
  insight: '気づき',
}

/** テーマの上限（見た目の文字数）。合成ページの中央に大きく出して2行に収まる長さにする */
export const MAX_THEME_LENGTH = 40

/** 1つのテーマで持てる論点の数。合成ページの枠（左右に3つずつ）に合わせる */
export const MAX_TOPICS = 6

/** 論点の名前の上限（見た目の文字数）。合成ページの論点の見出しに1行で収まる長さにする */
export const MAX_TOPIC_TITLE_LENGTH = 12

/** 意見1件の上限（見た目の文字数）。合成ページの札に2行で収まる長さにする */
export const MAX_OPINION_LENGTH = 40

/** 視聴者への問いかけ（観点の提案。issue #307）の上限（見た目の文字数）。合成ページの中央下に2行で収まる長さにする */
export const MAX_PROMPT_LENGTH = 40

/**
 * 同じ人のコメントを1つの発言につなげる間隔（ミリ秒）。
 *
 * チャットでは1つの意見を「AIのコメ返しは」「ちょっと寂しいかも」のように分けて書く人がいる。前のコメントからこの間隔の内に
 * 同じ人が書いたものは続きとみなし、最後のコメントからこの間隔が過ぎるまで、その人の発言は LLM に渡さずに待つ。
 */
export const MERGE_GAP_MS = 20_000

/** 1回の振り分けで LLM に渡す発言の数の上限。残りは次の回へ回す（1回の入力の量を一定に保つため） */
export const MAX_UTTERANCES_PER_SORT = 30

/** コメントを規則で落とした理由。command はコマンド、emote はエモートだけ、reaction は短い反応 */
export type DropReason = 'command' | 'emote' | 'reaction'

/** 規則で落とすかを決めるための、届いたコメントの中身 */
export interface IncomingComment {
  /** 本文（エモートの名前も文字として含む） */
  readonly text: string
  /** 本文の断片。エモートの断片だけ emoteId を持つ（worker/comment-feed.ts の readFragments で読んだもの） */
  readonly fragments: readonly { readonly text: string; readonly emoteId: string | null }[]
  /** ほかの人の発言への返信か */
  readonly replied: boolean
}

/** LLM に渡す前の、保留中のコメント（opinion_comments の行） */
export interface PendingComment {
  readonly id: number
  readonly userId: string
  /** 書いた人の表示名 */
  readonly userName: string
  readonly text: string
  /** 返信先の人の表示名。返信でなければ null */
  readonly replyName: string | null
  /** 返信先の発言の本文。返信でなければ null */
  readonly replyText: string | null
  /** 書かれた時刻（ISO 8601） */
  readonly sentAt: string
}

/** LLM に渡す1つの発言。同じ人が続けて書いたコメントをつなげたもの */
export interface Utterance {
  /** つなげたコメントのID（書かれた順） */
  readonly commentIds: readonly number[]
  readonly userName: string
  /** コメントの本文を空白でつなげたもの */
  readonly text: string
  readonly replyName: string | null
  readonly replyText: string | null
}

/** テーマ1件 */
export interface OpinionTheme {
  readonly id: number
  readonly title: string
  /** 開いた時刻（ISO 8601） */
  readonly openedAt: string
  /** 締め切った時刻（ISO 8601）。開いているあいだは null */
  readonly closedAt: string | null
  /** 合成ページの中央下に出す、視聴者への問いかけ（issue #307）。まだ作っていなければ null */
  readonly prompt: string | null
}

/** 合成ページへ渡す意見1件。人数は持たない（多数決に見せないため） */
export interface OverlayOpinion {
  readonly id: number
  readonly kind: OpinionKind
  readonly text: string
  /** 最初にこの意見を書いた人の表示名（「〇〇さんのコメントから」と添える） */
  readonly author: string
  /** 意見を作った時刻（ISO 8601） */
  readonly createdAt: string
}

/** 合成ページへ渡す論点1つ。意見は新しい順 */
export interface OverlayTopic {
  readonly id: number
  readonly title: string
  readonly opinions: readonly OverlayOpinion[]
}

/**
 * 合成ページへ渡す、いまの意見ボード（読み出しと押し出しで同じ形。src/opinions/entry.ts と合わせる）。
 *
 * テーマは最後に開いたもの（締め切ったあとも、次のテーマを開くまで映し続ける）。隠した意見は含めない。
 * まだ一度もテーマを開いていなければ theme は null で、論点は空。
 */
export interface OpinionBoardSnapshot {
  readonly theme: OpinionTheme | null
  /** 作った順の論点 */
  readonly topics: readonly OverlayTopic[]
}

/** 管理画面へ渡す、意見のもとになったコメント1件 */
export interface OpinionSource {
  readonly userName: string
  readonly text: string
}

/** 管理画面へ渡す意見1件。隠したものも含め、人数ともとのコメントを持つ */
export interface AdminOpinion extends OverlayOpinion {
  readonly hidden: boolean
  /** この意見を書いた人数（同じ人の重複は1人に数える） */
  readonly people: number
  /** もとになったコメント（書かれた順） */
  readonly sources: readonly OpinionSource[]
}

/** 管理画面へ渡す論点1つ */
export interface AdminTopic {
  readonly id: number
  readonly title: string
  readonly opinions: readonly AdminOpinion[]
}

/** 救い出せるコメントの状態。pending は、締め切ったときに振り分け待ちだったもの */
export type RescuableStatus = 'pending' | 'dropped' | 'filtered' | 'ignored' | 'failed'

/**
 * テーマを出しているあいだに受け取ったコメントの内訳（issue #308）。
 *
 * 規則で落としたもの（dropped。理由ごと）・Jev が意見ではないとみたもの（filtered）・LLM が無関係としたもの（ignored）を分けて数える。
 */
export interface OpinionCommentCounts {
  /** 受け取ったコメントの数（落としたものも含む） */
  readonly received: number
  /** 意見になった数 */
  readonly used: number
  /** 振り分け待ちの数 */
  readonly pending: number
  /** 規則で落とした数（理由ごと） */
  readonly dropped: Readonly<Record<DropReason, number>>
  readonly filtered: number
  readonly ignored: number
  /** 振り分けに失敗した回の数 */
  readonly failed: number
}

/** 管理画面へ渡す、意見にならなかったコメント1件。配信者が救い出せる（issue #308） */
export interface RescuableComment {
  readonly id: number
  readonly userName: string
  readonly text: string
  readonly replyName: string | null
  readonly replyText: string | null
  /** 書かれた時刻（ISO 8601） */
  readonly sentAt: string
  readonly status: RescuableStatus
  /** 規則で落とした理由。規則で落としていなければ null */
  readonly dropReason: DropReason | null
  /** Jev の確率。尋ねていなければ null */
  readonly jevScore: number | null
}

/** 管理画面へ渡す、いまの意見ボード */
export interface AdminOpinionBoard {
  readonly theme: OpinionTheme | null
  readonly topics: readonly AdminTopic[]
  /** コメントの内訳。テーマを開いたことがなければ全部 0 */
  readonly counts: OpinionCommentCounts
  /** 救い出せるコメント（新しい順） */
  readonly rescuable: readonly RescuableComment[]
}

/** 意見を入れる論点。既にある論点か、新しく作る論点 */
export type TopicChoice = { readonly type: 'existing'; readonly id: number } | { readonly type: 'new'; readonly title: string }

/** 配信者が、救い出したコメントから作る意見 */
export interface RescuedOpinionInput {
  readonly kind: OpinionKind
  readonly text: string
  readonly topic: TopicChoice
}

/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '意見ボードのテーマ'

/** 見た目の1文字（書記素クラスタ）ごとに分ける（テキスト・作業机と同じ数え方） */
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' })

/** 見た目の文字数を数える */
export const lengthOf = (text: string): number => [...graphemes.segment(text)].length

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から受け取ったテーマを検証する。
 *
 * @throws ConfigError テーマが文字列でない・空・上限を超える場合（index.ts が問題点付きの400にする）
 */
export const parseThemeInput = (body: unknown): { title: string } => {
  const title = isRecord(body) ? body.title : undefined
  if (typeof title !== 'string') throw new ConfigError(SUBJECT, ['テーマを文字で入力してください'])
  const trimmed = title.trim()
  if (trimmed === '') throw new ConfigError(SUBJECT, ['テーマを入力してください'])
  const length = lengthOf(trimmed)
  if (length > MAX_THEME_LENGTH) throw new ConfigError(SUBJECT, [`テーマは${MAX_THEME_LENGTH}文字以内にしてください（いまは${length}文字です）`])
  return { title: trimmed }
}

/**
 * 文字の入力を、前後の空白を落として検証する。空・上限を超えるものは切り詰めずに問題点にする（方針4）。
 *
 * @returns 落とした文字。問題があれば problems に足して null
 */
const readText = (value: unknown, name: string, max: number, problems: string[]): string | null => {
  if (typeof value !== 'string') {
    problems.push(`${name}を文字で入力してください`)
    return null
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    problems.push(`${name}を入力してください`)
    return null
  }
  const length = lengthOf(trimmed)
  if (length > max) {
    problems.push(`${name}は${max}文字以内にしてください（いまは${length}文字です）`)
    return null
  }
  return trimmed
}

/** 論点の指し方を読む。崩れていれば problems に足して null */
const readTopicChoice = (value: unknown, problems: string[]): TopicChoice | null => {
  if (isRecord(value) && value.type === 'existing') {
    if (typeof value.id === 'number' && Number.isInteger(value.id) && value.id > 0) return { type: 'existing', id: value.id }
    problems.push('入れる論点を選んでください')
    return null
  }
  if (isRecord(value) && value.type === 'new') {
    const title = readText(value.title, '新しい論点の名前', MAX_TOPIC_TITLE_LENGTH, problems)
    return title === null ? null : { type: 'new', title }
  }
  problems.push('入れる論点を選ぶか、新しい論点の名前を入力してください')
  return null
}

/**
 * 管理画面から受け取った、救い出したコメントから作る意見を検証する（issue #308）。
 *
 * @throws ConfigError 札の種類・1文・論点の指し方に問題がある場合（問題点をまとめて投げる）
 */
export const parseRescuedOpinionInput = (body: unknown): RescuedOpinionInput => {
  const record = isRecord(body) ? body : {}
  const problems: string[] = []
  const kind = OPINION_KINDS.find((candidate) => candidate === record.kind)
  if (kind === undefined) problems.push(`札の種類は ${OPINION_KINDS.join('・')} のどれかにしてください`)
  const text = readText(record.text, '意見', MAX_OPINION_LENGTH, problems)
  const topic = readTopicChoice(record.topic, problems)
  if (kind === undefined || text === null || topic === null) throw new ConfigError('救い出す意見', problems)
  return { kind, text, topic }
}

/**
 * 管理画面から受け取った論点の名前を検証する（issue #308）。
 *
 * @throws ConfigError 名前が文字列でない・空・上限を超える場合
 */
export const parseTopicTitleInput = (body: unknown): { title: string } => {
  const problems: string[] = []
  const title = readText(isRecord(body) ? body.title : undefined, '論点の名前', MAX_TOPIC_TITLE_LENGTH, problems)
  if (title === null) throw new ConfigError('論点の名前', problems)
  return { title }
}

/**
 * 選んだ論点が、いまの論点と食い違わないかを確かめる（issue #308）。
 *
 * @param topics いまの論点
 * @returns 食い違いの説明。食い違わなければ null
 */
export const topicChoiceProblem = (topics: readonly { readonly id: number; readonly title: string }[], choice: TopicChoice): string | null => {
  if (choice.type === 'existing') {
    return topics.some(({ id }) => id === choice.id) ? null : '選んだ論点が見つかりません（ほかの窓でまとめられた可能性があります）'
  }
  if (topics.some(({ title }) => title === choice.title)) return `論点「${choice.title}」は既にあります。その論点を選んでください`
  if (topics.length >= MAX_TOPICS) return `論点は${MAX_TOPICS}つまでです。既にある論点を選んでください`
  return null
}

/** コマンドの先頭に付ける文字（worker/chat-command.ts と同じ） */
const COMMAND_PREFIX = '!'

/** 短い反応とみなす長さ（見た目の文字数）。これ以下の文は意見になりえないとみなす */
const MAX_REACTION_LENGTH = 2

/** 笑い・拍手・記号だけでできた反応（「草」「www」「888」「!?」など） */
const REACTION_PATTERN = /^[\p{P}\p{S}\s0-9０-９wｗWＷ草笑]+$/u

/**
 * コメントを、LLM に渡さずに規則で落とすかを決める。
 *
 * 返信は、短い反応でも落とさない（「それな」は返信先の意見への賛同として LLM が振り分けるため）。
 * コマンドとエモートだけのコメントは、返信でも落とす。
 *
 * @returns 落とす理由。落とさなければ null
 */
export const dropReasonOf = (comment: IncomingComment): DropReason | null => {
  if (comment.text.trim().startsWith(COMMAND_PREFIX)) return 'command'
  const words = comment.fragments
    .filter(({ emoteId }) => emoteId === null)
    .map(({ text }) => text)
    .join('')
    .trim()
  if (words === '') return 'emote'
  if (comment.replied) return null
  if (lengthOf(words) <= MAX_REACTION_LENGTH || REACTION_PATTERN.test(words)) return 'reaction'
  return null
}

/**
 * 保留中のコメントから、いま LLM に渡せる発言を作る。
 *
 * 同じ人のコメントは、前のコメントから MERGE_GAP_MS の内に書かれたものを続きとして1つの発言につなげる（ほかの人のコメントを
 * 挟んでいてもつなげる）。最後のコメントから MERGE_GAP_MS が過ぎていない発言は、続きが来るかもしれないので丸ごと待つ。
 * 返信先は、発言の最初のコメントのものを添える。
 *
 * @param comments 保留中のコメント（書かれた順）
 * @param now 現在時刻（ミリ秒）
 * @returns 渡せる発言（最初のコメントが書かれた順）。上限（MAX_UTTERANCES_PER_SORT）を超えた分は次の回へ回す
 */
export const readyUtterances = (comments: readonly PendingComment[], now: number): Utterance[] => {
  /** つなげたコメントの並び。少なくとも1件を持つ */
  type Chain = [PendingComment, ...PendingComment[]]
  /** 人ごとの、つなげている途中の発言（最初のコメントが書かれた順に並べるため、作った順に持つ） */
  const chains: Chain[] = []
  const openChainOf = new Map<string, Chain>()
  for (const comment of comments) {
    const chain = openChainOf.get(comment.userId)
    const last = chain?.at(-1)
    if (chain !== undefined && last !== undefined && Date.parse(comment.sentAt) - Date.parse(last.sentAt) <= MERGE_GAP_MS) {
      chain.push(comment)
      continue
    }
    const created: Chain = [comment]
    chains.push(created)
    openChainOf.set(comment.userId, created)
  }

  return chains
    // 最後のコメント（空でない並びなので reduce で必ず1件に決まる）から間隔が過ぎたものだけを渡す
    .filter((chain) => now - Date.parse(chain.reduce((_, comment) => comment).sentAt) >= MERGE_GAP_MS)
    .slice(0, MAX_UTTERANCES_PER_SORT)
    .map(([first, ...rest]) => ({
      commentIds: [first.id, ...rest.map(({ id }) => id)],
      userName: first.userName,
      text: [first, ...rest].map(({ text }) => text.trim()).join(' '),
      replyName: first.replyName,
      replyText: first.replyText,
    }))
}
