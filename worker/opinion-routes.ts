/**
 * 意見ボードの経路（issue #306）
 *
 * 配信者がテーマを出して視聴者のコメントから意見を取り出す機能を、アプリのページ（/opinions/）と合成ページから使う。
 * - GET /api/admin/opinions: 最後に開いたテーマの意見ボードを、隠した意見・人数・もとのコメントを添えて返す
 * - POST /api/admin/opinions/themes: テーマを開き（{ title }）、振り分けのアラームを仕掛ける。ほかのテーマが開いていれば409
 * - POST /api/admin/opinions/themes/:id/close: テーマを締め切り、振り分けのアラームを外す。開いていないテーマなら404
 * - POST /api/admin/opinions/themes/:id/prompt: 開いているテーマの、視聴者への問いかけを別のものに替える（LLM に作らせる。issue #307）
 * - PUT /api/admin/opinions/items/:id: 意見を隠す・隠すのをやめる（{ hidden }）。荒らし対策
 * - POST /api/admin/opinions/comments/:id/draft: 意見にならなかったコメントから、意見の下書きを LLM に作らせて返す（保存しない。issue #308）
 * - POST /api/admin/opinions/comments/:id/opinion: 意見にならなかったコメントを、配信者が直した意見にする（{ kind, text, topic }。issue #308）
 * - POST /api/admin/opinions/comments/:id/join: 意見にならなかったコメントを、既にある意見に統合する（{ opinionId }。issue #308）
 * - PUT /api/admin/opinions/topics/:id: 論点の名前を書き換える（{ title }。issue #308）
 * - POST /api/admin/opinions/topics/:id/merge: 論点を別の論点（{ into }）にまとめる。まとめ先の名前を残す（issue #308）
 * - GET /api/overlay/opinions: 合成ページへ、人数を含まない意見ボードを返す（オーバーレイ用キー）
 * - GET /api/overlay/opinions/socket: 意見ボードが変わるたびに丸ごと押し出してもらう WebSocket。接続を保持するのはアラートと同じ
 *   Durable Object（worker/alert-channel.ts）で、ここはキーを確かめて引き渡すだけである
 *
 * 救い出し・論点の整理は、最後に開いたテーマ（管理画面に出ているもの）にだけ行え、締め切ったあとも行える。
 *
 * 開く・締め切る・問いかけを替える・隠す・救い出す・論点を整理するたびに、いまの意見ボードを丸ごと合成ページへ押し出す（テキストと同じ形）。
 *
 * 注意: 押し出し・アラームの操作に失敗しても、保存は取り消さない。アラームの操作に失敗したときも、先に意見ボードを押し出す。ただし黙って成功にもせず、保存は済んだことを添えて502で返す（方針4）。
 */
import { ConfigError } from './alert-config'
import { connectOpinionSocket, pushOpinions } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { parseRescuedOpinionInput, parseThemeInput, parseTopicTitleInput, topicChoiceProblem, type OpinionTheme, type RescuedOpinionInput } from './opinion'
import { draftOpinion } from './opinion-draft'
import { replaceOpinionPrompt } from './opinion-run'
import {
  closeTheme,
  joinRescuedComment,
  mergeTopics,
  openTheme,
  readAdminBoard,
  readLatestTheme,
  readLatestThemeTopics,
  readOpenTheme,
  readOverlayBoard,
  readRescuableComment,
  readSortingBoard,
  renameTopic,
  saveRescuedOpinion,
  setOpinionHidden,
} from './opinion-store'
import { startOpinionTimer, stopOpinionTimer } from './opinion-timer'
import { overlayKeyTag } from './overlay-key'

/** 経路の :id として受け付ける書式（1以上の整数） */
const ID = /^[1-9][0-9]*$/

const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 経路の :id を読む。
 *
 * @throws HttpError IDとして読めなければ、notFound が作る404（そのIDのものは無いので）
 */
const idOf = (context: Context, notFound: (raw: string) => HttpError): number => {
  const raw = context.params.id ?? ''
  if (!ID.test(raw)) throw notFound(raw)
  return Number(raw)
}

const themeNotFound = (raw: string): HttpError =>
  new HttpError(STATUS.notFound, 'opinion-theme-not-open', `テーマ「${raw}」は開いていません（別の窓で締め切られた可能性があります）`)

const opinionNotFound = (raw: string): HttpError => new HttpError(STATUS.notFound, 'opinion-not-found', `意見「${raw}」はありません`)

const commentNotRescuable = (raw: string): HttpError =>
  new HttpError(
    STATUS.notFound,
    'opinion-comment-not-rescuable',
    `コメント「${raw}」は救い出せません（ほかの窓で意見にした・次のテーマを出した可能性があります）`,
  )

const topicNotFound = (raw: string): HttpError =>
  new HttpError(STATUS.notFound, 'opinion-topic-not-found', `論点「${raw}」はありません（ほかの窓でまとめた・次のテーマを出した可能性があります）`)

const topicConflict = (message: string): HttpError => new HttpError(STATUS.conflict, 'opinion-topic-conflict', message)

/**
 * 本文の、1以上の整数で指すIDの欄を読む。
 *
 * @throws ConfigError 1以上の整数でない場合（index.ts が問題点付きの400にする）
 */
const bodyIdOf = (body: unknown, field: string, subject: string, problem: string): number => {
  const value = isRecord(body) ? body[field] : undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ConfigError(subject, [problem])
  return value
}

/**
 * いまの意見ボードを合成ページへ押し出す。
 *
 * @param done 何を済ませたか（失敗の文面に添える）
 * @throws HttpError 押し出せなければ502
 */
const pushCurrentBoard = async (context: Context, done: string): Promise<void> => {
  const board = await readOverlayBoard(context.env.DB)
  try {
    await pushOpinions(context.env.ALERTS, board)
  } catch (error) {
    throw new HttpError(
      STATUS.badGateway,
      'opinion-push-failed',
      `${done}が、合成ページへすぐには送れませんでした。合成ページは5分以内に読み直して映します（${reasonOf(error)}）`,
    )
  }
}

/** GET /api/admin/opinions: 最後に開いたテーマの意見ボード（隠した意見・人数・もとのコメントつき） */
export const getAdminOpinions = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await readAdminBoard(context.env.DB))
}

/**
 * POST /api/admin/opinions/themes: テーマを開き、振り分けのアラームを仕掛けて、意見ボードを押し出す。
 *
 * @throws ConfigError テーマが空・上限を超える場合（index.ts が問題点付きの400にする）
 * @throws HttpError ほかのテーマが開いていれば409。アラームを仕掛けられない・押し出せなければ502
 */
export const postOpinionTheme = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { title } = parseThemeInput(await readJson(context))
  const theme = await openTheme(context.env.DB, title, context.now)
  if (theme === null) {
    throw new HttpError(STATUS.conflict, 'opinion-theme-open', 'ほかのテーマが開いています。締め切ってから新しいテーマを開いてください')
  }
  // アラームを仕掛けられなくても、テーマは開いたので、先に合成ページへ押し出してから失敗を返す（配信画面を古いままにしない）
  const timerError = await startOpinionTimer(context.env.AD_BREAKS).then(
    () => null,
    (error: unknown) => error,
  )
  await pushCurrentBoard(context, 'テーマを開きました')
  if (timerError !== null) {
    throw new HttpError(
      STATUS.badGateway,
      'opinion-timer-failed',
      `テーマを開きましたが、コメントの振り分けを始められませんでした。いったん締め切って開き直してください（${reasonOf(timerError)}）`,
    )
  }
  return Response.json({ theme } satisfies { theme: OpinionTheme }, { status: STATUS.created })
}

/**
 * POST /api/admin/opinions/themes/:id/close: テーマを締め切り、振り分けのアラームを外して、意見ボードを押し出す。
 *
 * まだ振り分けていないコメントは振り分け待ちのまま残す（締め切ったあとは振り分けない）。
 *
 * @throws HttpError 開いていないテーマなら404。押し出せなければ502
 */
export const postCloseOpinionTheme = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, themeNotFound)
  const theme = await closeTheme(context.env.DB, id, context.now)
  if (theme === null) throw themeNotFound(String(id))
  // アラームを外せなくても、テーマは締め切ったので、先に合成ページへ押し出してから失敗を返す（配信画面を古いままにしない）
  const timerError = await stopOpinionTimer(context.env.AD_BREAKS).then(
    () => null,
    (error: unknown) => error,
  )
  await pushCurrentBoard(context, 'テーマを締め切りました')
  if (timerError !== null) {
    // 止められなくても、次のアラームがテーマの締め切りを読んで止まるので、振り分けが続くことはない。黙らずに知らせる
    throw new HttpError(STATUS.badGateway, 'opinion-timer-failed', `テーマを締め切りましたが、振り分けのアラームを外せませんでした（${reasonOf(timerError)}）`)
  }
  return Response.json({ theme } satisfies { theme: OpinionTheme })
}

/**
 * POST /api/admin/opinions/themes/:id/prompt: 開いているテーマの問いかけを、いまの問いかけとは違う切り口で LLM に作り直させ、
 * 書いて意見ボードを押し出す。
 *
 * 作れなかったら前の問いかけを残す（切り詰めない。方針4）。
 *
 * @throws HttpError 開いていないテーマなら404。問いかけを作れなければ502（opinion-prompt-failed）。押し出せなければ502
 */
export const postOpinionPrompt = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, themeNotFound)
  const theme = await readOpenTheme(context.env.DB)
  if (theme?.id !== id) throw themeNotFound(String(id))
  const saved = await replaceOpinionPrompt(context.env.DB, context.llm, theme).catch((error: unknown) => {
    throw new HttpError(STATUS.badGateway, 'opinion-prompt-failed', `問いかけを作り直せませんでした。前の問いかけを残しています（${reasonOf(error)}）`)
  })
  // LLM を待つあいだに締め切られていたら、何も書いていない
  if (saved === null) throw themeNotFound(String(id))
  await pushCurrentBoard(context, '問いかけを替えました')
  return Response.json({ theme: saved } satisfies { theme: OpinionTheme })
}

/**
 * PUT /api/admin/opinions/items/:id: 意見を隠す・隠すのをやめて、意見ボードを押し出す。
 *
 * @throws ConfigError hidden が真偽値でない場合
 * @throws HttpError 無い意見なら404。押し出せなければ502
 */
export const putOpinion = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, opinionNotFound)
  const body = await readJson(context)
  const hidden = typeof body === 'object' && body !== null && 'hidden' in body ? body.hidden : undefined
  if (typeof hidden !== 'boolean') throw new ConfigError('意見', ['hidden は true か false にしてください'])
  if (!(await setOpinionHidden(context.env.DB, id, hidden))) throw opinionNotFound(String(id))
  await pushCurrentBoard(context, hidden ? '意見を隠しました' : '意見を戻しました')
  return new Response(null, { status: STATUS.noContent })
}

/**
 * POST /api/admin/opinions/comments/:id/draft: 意見にならなかったコメントから、意見の下書き（札の種類・1文・論点）を LLM に作らせて
 * 返す。保存はしない（配信者が直してから /opinion で保存する）。
 *
 * @throws HttpError 救い出せないコメントなら404。下書きを作れなければ502（opinion-draft-failed）
 */
export const postOpinionDraft = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, commentNotRescuable)
  const [comment, theme] = await Promise.all([readRescuableComment(context.env.DB, id), readLatestTheme(context.env.DB)])
  if (comment === null || theme === null) throw commentNotRescuable(String(id))
  const draft = await draftOpinion(context.llm, { theme: theme.title, board: await readSortingBoard(context.env.DB, theme.id), comment }).catch(
    (error: unknown) => {
      throw new HttpError(STATUS.badGateway, 'opinion-draft-failed', `意見の下書きを作れませんでした。もう一度試してください（${reasonOf(error)}）`)
    },
  )
  return Response.json({ draft } satisfies { draft: RescuedOpinionInput })
}

/**
 * POST /api/admin/opinions/comments/:id/opinion: 意見にならなかったコメントを、配信者が直した意見にして、意見ボードを押し出す。
 *
 * @throws ConfigError 札の種類・1文・論点の指し方に問題がある場合
 * @throws HttpError 救い出せないコメントなら404。論点がいまの論点と食い違えば409。押し出せなければ502
 */
export const postRescuedOpinion = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, commentNotRescuable)
  const input = parseRescuedOpinionInput(await readJson(context))
  if ((await readRescuableComment(context.env.DB, id)) === null) throw commentNotRescuable(String(id))
  const problem = topicChoiceProblem(await readLatestThemeTopics(context.env.DB), input.topic)
  if (problem !== null) throw topicConflict(problem)
  if (!(await saveRescuedOpinion(context.env.DB, id, input, context.now))) throw commentNotRescuable(String(id))
  await pushCurrentBoard(context, 'コメントを意見にしました')
  return new Response(null, { status: STATUS.created })
}

/**
 * POST /api/admin/opinions/comments/:id/join: 意見にならなかったコメントを既にある意見に統合して、意見ボードを押し出す。
 *
 * @throws ConfigError opinionId が1以上の整数でない場合
 * @throws HttpError 救い出せないコメント・同じテーマに無い意見なら404。押し出せなければ502
 */
export const postJoinRescuedComment = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, commentNotRescuable)
  const opinionId = bodyIdOf(await readJson(context), 'opinionId', '統合先の意見', '統合する意見を選んでください')
  if ((await readRescuableComment(context.env.DB, id)) === null) throw commentNotRescuable(String(id))
  if (!(await joinRescuedComment(context.env.DB, id, opinionId))) throw opinionNotFound(String(opinionId))
  await pushCurrentBoard(context, 'コメントを意見に統合しました')
  return new Response(null, { status: STATUS.noContent })
}

/**
 * PUT /api/admin/opinions/topics/:id: 論点の名前を書き換えて、意見ボードを押し出す。
 *
 * @throws ConfigError 名前が空・上限を超える場合
 * @throws HttpError 最後に開いたテーマに無い論点なら404。ほかの論点と同じ名前なら409。押し出せなければ502
 */
export const putOpinionTopic = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, topicNotFound)
  const { title } = parseTopicTitleInput(await readJson(context))
  const topics = await readLatestThemeTopics(context.env.DB)
  if (!topics.some((topic) => topic.id === id)) throw topicNotFound(String(id))
  if (topics.some((topic) => topic.id !== id && topic.title === title)) throw topicConflict(`論点「${title}」は既にあります。まとめるときは「ほかの論点とまとめる」を使ってください`)
  if (!(await renameTopic(context.env.DB, id, title))) throw topicNotFound(String(id))
  await pushCurrentBoard(context, '論点の名前を変えました')
  return new Response(null, { status: STATUS.noContent })
}

/**
 * POST /api/admin/opinions/topics/:id/merge: 論点（:id）の意見を別の論点（into）へ移して1つにまとめ、意見ボードを押し出す。
 * まとめ先の名前を残す（LLM に名前を付け直させない）。
 *
 * @throws ConfigError into が1以上の整数でない・まとめる側と同じ場合
 * @throws HttpError どちらかが最後に開いたテーマに無い論点なら404。押し出せなければ502
 */
export const postMergeOpinionTopics = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, topicNotFound)
  const into = bodyIdOf(await readJson(context), 'into', '論点のまとめ先', 'まとめ先の論点を選んでください')
  if (into === id) throw new ConfigError('論点のまとめ先', ['まとめ先には、ほかの論点を選んでください'])
  if (!(await mergeTopics(context.env.DB, id, into))) {
    const topicIds = new Set((await readLatestThemeTopics(context.env.DB)).map((topic) => topic.id))
    throw topicNotFound(String(topicIds.has(id) ? into : id))
  }
  await pushCurrentBoard(context, '論点をまとめました')
  return new Response(null, { status: STATUS.noContent })
}

/** GET /api/overlay/opinions?key=: 人数を含まない意見ボード */
export const getOverlayOpinions = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json(await readOverlayBoard(context.env.DB))
}

/** GET /api/overlay/opinions/socket?key=: 合成ページからのWebSocketの接続を、意見ボードを受け取る接続として配送先へ引き渡す */
export const opinionSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectOpinionSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}
