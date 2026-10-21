/**
 * 人形の経路
 *
 * 視聴者が所持する人形（issue #418）を、アプリのページ（/dolls/・/viewers/）から使う。どれも配信者のセッションが要る。
 * - GET /api/admin/dolls: 人形の組（追加した順）と、持っている人の組ごとの所持数を返す
 * - POST /api/admin/dolls: 人形の組を検証して追加する（{ normal: { name, mediaId }, super: { name, mediaId } }）
 * - PUT /api/admin/dolls/:id: 人形の組の名前と画像を検証して書き換える（同上）
 * - DELETE /api/admin/dolls/:id: 人形の組を消す（台帳に記録のある組は409）
 * - PUT /api/admin/doll-current: いまの人形を選ぶ（{ setId: 組の ID | null }）。組の一覧を返す
 * - POST /api/admin/viewers/:userId/dolls: 視聴者にいまの人形を手で渡す・取り上げる（{ kind, delta }）。増減したあとの所持数を返す
 * - GET・PUT /api/admin/doll-prizes/:game: ゲーム（chatDeduction・kanjiQuiz）の正解者に渡す人形を読み書きする（{ kind: 'normal' | 'super' | null }。issue #420）
 *
 * 読み書きは worker/doll-store.ts（正解者に渡す人形は worker/doll-prize.ts）、検証は worker/doll.ts にある。
 */
import { DOLL_PRIZE_GAMES, parseDollChangeInput, parseDollPrize, parseDollSetInput, type DollHolding, type DollPrize, type DollPrizeGame, type DollSet } from './doll'
import { loadDollPrize, saveDollPrize } from './doll-prize'
import { DollChangeError, changeDolls, deleteDollSet, insertDollSet, readDollHoldings, readDollSets, selectCurrentDollSet, updateDollSet } from './doll-store'
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { listMedia } from './media'
import { readViewer } from './viewer-store'

/** 経路の :id として受け付ける書式（1以上の整数） */
const DOLL_SET_ID = /^[1-9][0-9]*$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

const notFound = (raw: string): HttpError =>
  new HttpError(STATUS.notFound, 'doll-set-not-found', `人形の組「${raw}」はありません（別の窓で消された可能性があります）`)

/**
 * 経路の :id を人形の組の ID として読む。
 *
 * @throws HttpError ID として読めなければ404（その ID の組は無いので）
 */
const dollSetIdOf = (context: Context): number => {
  const raw = context.params.id ?? ''
  if (!DOLL_SET_ID.test(raw)) throw notFound(raw)
  return Number(raw)
}

/** 本文を人形の組として検証する。画像は、いまアップロードされている素材の種類で確かめる */
const readDollSetInput = async (context: Context) => {
  const body = await readJson(context)
  const kinds = new Map((await listMedia(context.env.MEDIA)).map((item) => [item.id, item.kind]))
  return parseDollSetInput(body, (mediaId) => kinds.get(mediaId) ?? null)
}

/** GET /api/admin/dolls: 人形の組と、持っている人の所持数 */
export const getDolls = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { DB } = context.env
  return Response.json({ sets: await readDollSets(DB), holdings: await readDollHoldings(DB) } satisfies { sets: DollSet[]; holdings: DollHolding[] })
}

/**
 * POST /api/admin/dolls: 人形の組を検証して追加する。
 *
 * @throws ConfigError 名前・画像に問題がある場合（index.ts が問題点付きの400にする）
 */
export const postDollSet = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const input = await readDollSetInput(context)
  const set = await insertDollSet(context.env.DB, input, context.now)
  return Response.json({ set } satisfies { set: DollSet }, { status: STATUS.created })
}

/**
 * PUT /api/admin/dolls/:id: 人形の組の名前と画像を検証して書き換える。
 *
 * @throws ConfigError 名前・画像に問題がある場合
 * @throws HttpError その組が無ければ404
 */
export const putDollSet = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = dollSetIdOf(context)
  const input = await readDollSetInput(context)
  const set = await updateDollSet(context.env.DB, id, input, context.now)
  if (set === null) throw notFound(String(id))
  return Response.json({ set } satisfies { set: DollSet })
}

/**
 * DELETE /api/admin/dolls/:id: 人形の組を消す。
 *
 * @throws HttpError その組が無ければ404、台帳に記録がある（誰かに渡したことがある）なら409
 */
export const removeDollSet = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = dollSetIdOf(context)
  const result = await deleteDollSet(context.env.DB, id)
  if (result === 'not-found') throw notFound(String(id))
  if (result === 'in-use') {
    throw new HttpError(STATUS.conflict, 'doll-set-in-use', 'この人形はもう視聴者に渡したことがあるので消せません（集めた記録が残っています）')
  }
  return new Response(null, { status: STATUS.noContent })
}

/**
 * PUT /api/admin/doll-current: いまの人形を選ぶ（setId が null なら、どの組も選ばない）。
 *
 * @throws HttpError setId が組の ID でも null でもなければ400、その組が無ければ404
 */
export const putCurrentDollSet = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body = await readJson(context)
  const setId: unknown = isRecord(body) ? body.setId : undefined
  if (setId !== null && !(typeof setId === 'number' && Number.isInteger(setId) && setId > 0)) {
    throw new HttpError(STATUS.badRequest, 'invalid-doll-set-id', 'setId は人形の組の ID か、選ばないことを表す null にしてください')
  }
  if (!(await selectCurrentDollSet(context.env.DB, setId))) throw notFound(String(setId))
  return Response.json({ sets: await readDollSets(context.env.DB) } satisfies { sets: DollSet[] })
}

/**
 * POST /api/admin/viewers/:userId/dolls: 視聴者にいまの人形を手で渡す（delta が正）・取り上げる（負）。
 *
 * きっかけの ID は毎回新しく振る（手での増減は、押すたびに別の増減なので）。
 *
 * @throws ConfigError 増減の形に問題がある場合
 * @throws HttpError 記録の無い視聴者なら404、いまの人形が無い・取り上げるだけの所持数が無いなら409
 */
export const postViewerDolls = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const userId = context.params.userId ?? ''
  const input = parseDollChangeInput(await readJson(context))
  if ((await readViewer(context.env.DB, userId)) === null) {
    throw new HttpError(STATUS.notFound, 'viewer-not-found', `視聴者「${userId}」の記録が存在しません`)
  }

  try {
    const result = await changeDolls(context.env.DB, { userId, ...input, reason: 'manual', sourceId: `manual:${crypto.randomUUID()}` }, context.now)
    // 毎回新しい ID を振るので、再送として扱われることは無い
    if (result.status === 'duplicate') throw new Error('手での人形の増減が、すでに記録した増減と同じ ID になりました')
    return Response.json({ holding: result.holding } satisfies { holding: DollHolding })
  } catch (error) {
    if (error instanceof DollChangeError) throw new HttpError(STATUS.conflict, error.code, error.message)
    throw error
  }
}

/**
 * 経路の :game を、正解者に人形を渡せるゲームとして読む。
 *
 * @throws HttpError 知らないゲームなら404
 */
const prizeGameOf = (context: Context): DollPrizeGame => {
  const raw = context.params.game ?? ''
  const game = DOLL_PRIZE_GAMES.find((candidate) => candidate === raw)
  if (game === undefined) throw new HttpError(STATUS.notFound, 'doll-prize-game-not-found', `ゲーム「${raw}」の正解者には人形を渡せません`)
  return game
}

/** GET /api/admin/doll-prizes/:game: そのゲームの正解者に渡す人形。保存していなければ渡さない（kind: null） */
export const getDollPrize = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json((await loadDollPrize(context.env.STORE, prizeGameOf(context))) satisfies DollPrize)
}

/**
 * PUT /api/admin/doll-prizes/:game: そのゲームの正解者に渡す人形を検証して保存し、保存したものを返す。
 *
 * @throws ConfigError 種類に問題がある場合
 * @throws HttpError 知らないゲームなら404
 */
export const putDollPrize = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const game = prizeGameOf(context)
  const prize = parseDollPrize(await readJson(context))
  await saveDollPrize(context.env.STORE, game, prize)
  return Response.json(prize satisfies DollPrize)
}
