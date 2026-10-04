/**
 * チャンネルポイント報酬の経路（/api/admin/rewards）
 *
 * 配信者のセッションが必要。報酬の一覧（トリガーの管理画面で報酬を選ぶのにも使う）と、
 * 管理画面（/rewards/）からの作成・更新・削除を受け持つ（issue #160）。
 *
 * 注意: Twitchは、同じ Client ID（このアプリ）で作った報酬しか更新・削除させない。
 * 一覧ではそれを manageable として添え、画面が操作できない報酬を見分けられるようにする。
 * 注意: 書き換えには配信者のトークンの channel:manage:redemptions が要る。スコープを追加する前に
 * ログインしたトークンには無いので、Twitchへ送る前に確かめて、ログインし直しを求める（Twitchの英語の403で気づかせない）。
 */
import { loadAlertConfig } from './alert-config'
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { parseRewardInput } from './reward-input'
import { AuthError, getAccessToken, type StoredToken } from './token'
import type { CustomReward } from './twitch'

/** 報酬の書き換え（作成・更新・削除）に要るスコープ */
const MANAGE_SCOPE = 'channel:manage:redemptions'

/** 画面へ返す報酬。HDADから更新・削除できるかどうかを添える */
type RewardResponse = CustomReward & { manageable: boolean }

/** 本文をJSONとして読む。読めなければ400にする */
const readBody = (request: Request): Promise<unknown> =>
  request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

/**
 * 経路の :id（報酬ID）を取り出す。
 *
 * 経路の定義上は必ず入っているが、空文字で進めてTwitchへ送らないよう、無ければ400にする（Fail-Fast）。
 */
const requireRewardId = ({ params }: Context): string => {
  const id = params.id
  if (id === undefined || id === '') throw new HttpError(STATUS.badRequest, 'invalid-path', '報酬IDを指定してください')
  return id
}

/**
 * 報酬を書き換えられる配信者のトークンを取り出す。
 *
 * @throws AuthError トークンが保管されていない・更新できない・channel:manage:redemptions が無い
 */
const getManageToken = async ({ env, twitch, now }: Context): Promise<StoredToken> => {
  const token = await getAccessToken(env.TOKENS, 'broadcaster', twitch, now)
  if (!token.scopes.includes(MANAGE_SCOPE)) {
    throw new AuthError('missing-scope', `配信者のトークンに ${MANAGE_SCOPE} がありません。ログインし直してください（チャンネルポイント報酬を変更できません）`)
  }
  return token
}

/**
 * GET /api/admin/rewards: 配信者のチャンネルポイント報酬の一覧。トークンは応答に含めない。
 *
 * すべての報酬と、このアプリが作った報酬だけの一覧の2つを取り、後者に含まれるものに manageable を立てる。
 * 読むだけなので channel:read:redemptions で足りる（トリガーの管理画面はスコープの追加前のトークンでも使える）。
 *
 * @throws AuthError トークンが保管されていない・更新できない
 * @throws TwitchApiError Twitchが失敗を返した（チャンネルポイントを使えないチャンネルなど）
 */
export const getRewards = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env, twitch, now } = context
  const { accessToken } = await getAccessToken(env.TOKENS, 'broadcaster', twitch, now)
  const [all, manageable] = await Promise.all([
    twitch.listCustomRewards(accessToken, env.TWITCH_BROADCASTER_ID),
    twitch.listCustomRewards(accessToken, env.TWITCH_BROADCASTER_ID, { onlyManageable: true }),
  ])
  const manageableIds = new Set(manageable.map((reward) => reward.id))
  const rewards: RewardResponse[] = all.map((reward) => ({ ...reward, manageable: manageableIds.has(reward.id) }))
  return Response.json({ rewards })
}

/**
 * POST /api/admin/rewards: 入力を検証し、Twitchでチャンネルポイント報酬を作る。
 *
 * @throws ConfigError 入力に問題がある場合（index.ts が問題点付きの400にする）
 * @throws AuthError channel:manage:redemptions の無いトークンしか無い
 * @throws TwitchApiError Twitchが拒否した（同じ名前の報酬がある・50件の上限に達したなど）
 */
export const postReward = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const input = parseRewardInput(await readBody(context.request))
  const { accessToken } = await getManageToken(context)
  const reward = await context.twitch.createCustomReward(accessToken, context.env.TWITCH_BROADCASTER_ID, input)
  const created: RewardResponse = { ...reward, manageable: true }
  return Response.json(created, { status: STATUS.created })
}

/**
 * PATCH /api/admin/rewards/:id: 入力を検証し、Twitchでチャンネルポイント報酬を更新する。
 *
 * @throws ConfigError 入力に問題がある場合（index.ts が問題点付きの400にする）
 * @throws AuthError channel:manage:redemptions の無いトークンしか無い
 * @throws TwitchApiError Twitchが拒否した（このアプリが作っていない報酬など）
 */
export const patchReward = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const input = parseRewardInput(await readBody(context.request))
  const { accessToken } = await getManageToken(context)
  const reward = await context.twitch.updateCustomReward(accessToken, context.env.TWITCH_BROADCASTER_ID, requireRewardId(context), input)
  const updated: RewardResponse = { ...reward, manageable: true }
  return Response.json(updated)
}

/**
 * DELETE /api/admin/rewards/:id: Twitchでチャンネルポイント報酬を削除する。
 *
 * トリガーに使われている報酬は消させない（配信中にアラートが黙って出なくなるのを防ぐ。素材の削除と同じ扱い）。
 *
 * @throws HttpError トリガーに使われている場合（409）
 * @throws AuthError channel:manage:redemptions の無いトークンしか無い
 * @throws TwitchApiError Twitchが拒否した（このアプリが作っていない報酬など）
 */
export const deleteReward = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = requireRewardId(context)
  const { triggers } = await loadAlertConfig(context.env.STORE)
  if (triggers.some((trigger) => trigger.kind === 'reward' && trigger.rewardId === id)) {
    throw new HttpError(STATUS.conflict, 'reward-in-use', 'この報酬はトリガーに使われています。先にトリガーの設定から外してください')
  }
  const { accessToken } = await getManageToken(context)
  await context.twitch.deleteCustomReward(accessToken, context.env.TWITCH_BROADCASTER_ID, id)
  return new Response(null, { status: STATUS.noContent })
}
