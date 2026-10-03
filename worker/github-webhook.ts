/**
 * GitHub の Webhook の読み解き
 *
 * GitHub から届く通知の署名（X-Hub-Signature-256）を確かめ、出来事をトリガーの対象にする種別へ振り分ける。
 * 通信も時刻も持たない純粋な関数だけを置き、受け口そのもの（配信中かの確認・トリガーの実行）は worker/github-routes.ts が持つ。
 *
 * 扱う出来事は2つだけである。
 * - コミットの push（github.push）。main に限らずすべてのブランチを対象にする。作者の運用では main へ直接コミットしないので、
 *   main だけに絞ると「PRのマージ」と同じ瞬間にしか鳴らず、作業の途中の区切りを拾えないため
 * - PR のマージ（github.pull_request.merged）。pull_request のうち、マージして閉じられたものだけ
 *
 * 注意: 扱わない種類の出来事（issues など）は黙って捨てずにエラーにする。Webhook の設定で選ぶ出来事を誤ったことに、
 *   GitHub の Recent Deliveries の失敗から気付けるようにするためである（Fail-Fast）。一方、push と pull_request のうち
 *   トリガーの対象にならないもの（タグの push・マージしない PR の操作）は、届いて当然のものなので null を返して捨てる。
 */
import { signHex, timingSafeEqual } from './secret'
import { GITHUB_PULL_REQUEST_MERGED, GITHUB_PUSH } from './trigger-menu'

const SIGNATURE_PREFIX = 'sha256='
/** push の ref のうち、ブランチを表すものの頭（タグは refs/tags/ で始まる）。差し込むブランチ名からはこれを落とす */
export const BRANCH_REF_PREFIX = 'refs/heads/'

/** GitHub の X-GitHub-Event のうち、受け口が扱う種類 */
export const GITHUB_EVENT = { ping: 'ping', push: 'push', pullRequest: 'pull_request' } as const

interface GithubSignedBody {
  /** 届いた本文そのもの（JSON として読む前の文字列） */
  body: string
  /** X-Hub-Signature-256 の値（sha256= に続けて16進の HMAC-SHA256） */
  signature: string
  /** Webhook の設定に入れた鍵（GITHUB_WEBHOOK_SECRET） */
  secret: string
}

/**
 * 通知の署名が、Webhook の設定に入れた鍵で作られたものかを確かめる。
 *
 * EventSub と違い、GitHub の署名は本文だけに対して作られる（メッセージIDも時刻も含まない）。
 */
export const verifyGithubSignature = async ({ body, signature, secret }: GithubSignedBody): Promise<boolean> =>
  timingSafeEqual(signature, SIGNATURE_PREFIX + (await signHex(body, secret)))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * push が、新しいコミットを含むブランチへの push か。
 *
 * タグの push・ブランチの削除・既存のコミットからブランチを作っただけの push は含めない。
 * 最後のものは head_commit に既存のコミットが入るので、鳴らすと古いコミットのメッセージが配信に出てしまう。
 */
const isCommitPush = (payload: Record<string, unknown>): boolean =>
  typeof payload.ref === 'string' &&
  payload.ref.startsWith(BRANCH_REF_PREFIX) &&
  payload.deleted !== true &&
  Array.isArray(payload.commits) &&
  payload.commits.length > 0

/** pull_request の通知が、PR をマージして閉じたものか */
const isMerge = (payload: Record<string, unknown>): boolean =>
  payload.action === 'closed' && isRecord(payload.pull_request) && payload.pull_request.merged === true

/**
 * GitHub の出来事を、トリガーの対象にする種別へ振り分ける。
 *
 * @param eventName X-GitHub-Event の値（ping は呼び出し側が先に処理する）
 * @param payload 通知の本文
 * @returns トリガーの対象にする種別。届いて当然だが対象にならないもの（タグの push・マージしない PR の操作）は null
 * @throws 扱わない種類の出来事の場合
 */
export const githubAlertEventOf = (
  eventName: string,
  payload: Record<string, unknown>,
): typeof GITHUB_PUSH | typeof GITHUB_PULL_REQUEST_MERGED | null => {
  switch (eventName) {
    case GITHUB_EVENT.push:
      return isCommitPush(payload) ? GITHUB_PUSH : null
    case GITHUB_EVENT.pullRequest:
      return isMerge(payload) ? GITHUB_PULL_REQUEST_MERGED : null
    default:
      throw new Error(`扱わない種類の出来事です: ${eventName}（Webhook の設定で Pushes と Pull requests だけを選んでください）`)
  }
}
