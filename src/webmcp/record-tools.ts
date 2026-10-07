/**
 * WebMCP で登録する、記録を読むツール（issue #281 の段階3）
 *
 * ダッシュボード・視聴者・LLM のページで見られる記録（配信の一覧と詳細・視聴者の記録・LLM の使用状況と残高）を
 * エージェントが読めるようにする。視聴者のメモの保存だけは書き込みで、ほかは readOnlyHint を付ける。
 *
 * 視聴者が書いた文や、それを材料に LLM が作った文（章の要約・あらすじ・タイトルの候補・人物像・メモ）を返すツールには
 * untrustedContentHint を付ける。エージェントがその文の中の指示に従ってしまわないよう、出どころを知らせるためである。
 *
 * 注意: メモを保存しても、開いている視聴者のページの表示はページを開き直すまで変わらない（ページが一覧を開いたときに
 *   一度読むだけのため）。そのページでメモを保存し直すと、ツールで保存したメモを上書きする。
 * 注意: 視聴者の検索の条件（件数の上限・日時の形など）の検証は Worker が行う。
 */
import type { WebMCP } from 'webmcp-types'
import type { LlmApi, LlmState } from '@/llm/api'
import { summarizeLlmUsage } from '@/llm/usage'
import type { StatsApi } from '@/stats/api'
import type { ViewerApi, ViewerQuery } from '@/viewers/api'
import { NO_INPUT, readOptionalNumber, readOptionalString, readString } from './input'

/** 記録を読むツールが使う Worker の Api（名前はアプリの枠の PageContext と同じ） */
export interface RecordApis {
  statsApi: Pick<StatsApi, 'sessions' | 'session'>
  viewerApi: Pick<ViewerApi, 'list' | 'saveNote'>
  /** load は OpenRouter の鍵があるかを確かめるためだけに使う */
  llmApi: Pick<LlmApi, 'loadUsage' | 'loadCredits'> & { load(): Promise<Pick<LlmState, 'apiKeyConfigured'>> }
}

const READ_ONLY = { readOnlyHint: true } as const
/** 視聴者が書いた文や、それを材料に作った文を返す読み取り */
const READ_UNTRUSTED = { readOnlyHint: true, untrustedContentHint: true } as const

/** 視聴者の検索の条件を、入力に書かれたものだけで組み立てる（書かれていない条件は Worker の既定に任せる） */
const readViewerQuery = (input: Record<string, unknown>): ViewerQuery => {
  const search = readOptionalString(input, 'search')
  const before = readOptionalString(input, 'before')
  const beforeUserId = readOptionalString(input, 'beforeUserId')
  const limit = readOptionalNumber(input, 'limit')
  return {
    ...(search === undefined ? {} : { search }),
    ...(before === undefined ? {} : { before }),
    ...(beforeUserId === undefined ? {} : { beforeUserId }),
    ...(limit === undefined ? {} : { limit }),
  }
}

/**
 * 記録を読むツールを作る。
 *
 * @param apis Worker の Api（webmcp-tools.tsx がアプリの枠から渡す）
 * @param now 現在時刻（ミリ秒）を返す。LLM の使用状況の「今日」を決めるのに使う
 */
export const buildRecordTools = (apis: RecordApis, now: () => number): WebMCP.ModelContextTool[] => [
  {
    name: 'list_streams',
    title: '配信の一覧',
    description:
      '記録している配信の一覧を新しい順に返します。各配信の id・開始と終了の日時（UTC。配信中なら endedAt は null）・タイトル・カテゴリ・平均と最大の視聴者数・フォロワーの増減・イベントの種類ごとの件数を含みます。',
    inputSchema: NO_INPUT,
    annotations: READ_ONLY,
    execute: async () => JSON.stringify(await apis.statsApi.sessions()),
  },
  {
    name: 'get_stream',
    title: '配信の詳細',
    description:
      '配信1回ぶんの詳細を返します。約30分ごとの章（見出しと何が話されたかの要約）・章ごとの配信タイトルの候補と公開してよい確率・これまでのあらすじ・作業机の作業時間の合計を含みます。視聴者数の時系列は返しません。id には list_streams が返した id を指定します。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'list_streams が返した配信の id' } },
      required: ['id'],
    },
    annotations: READ_UNTRUSTED,
    execute: async (input) => {
      const detail = await apis.statsApi.session(readString(input, 'id'))
      // 視聴者数の時系列（samples）は数が多く、平均と最大は list_streams で読めるので返さない
      return JSON.stringify({
        id: detail.id,
        startedAt: detail.startedAt,
        endedAt: detail.endedAt,
        title: detail.title,
        categoryName: detail.categoryName,
        chapters: detail.chapters,
        titleCandidates: detail.titleCandidates,
        summary: detail.summary,
        workTime: detail.workTime,
      })
    },
  },
  {
    name: 'search_viewers',
    title: '視聴者を探す',
    description:
      'チャットで発言した人の記録を、最後に発言した順に返します。search でログイン名を前方一致で絞り込めます。続きを読むときは、前の結果の最後の人の lastSeenAt を before に、userId を beforeUserId に渡します。各人のメモ（note）・LLM が作った人物像（summary）・その人自身のチャンネルの内容（channel）も含みます。',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'ログイン名の前方一致' },
        before: { type: 'string', description: 'この日時（ISO 8601）より前に発言した人だけを返す' },
        beforeUserId: { type: 'string', description: 'before と同じ日時の人をどこまで読んだかの目印（前の結果の最後の userId）' },
        limit: { type: 'integer', minimum: 1, description: '返す人数（省くと50人）' },
      },
    },
    annotations: READ_UNTRUSTED,
    execute: async (input) => JSON.stringify(await apis.viewerApi.list(readViewerQuery(input))),
  },
  {
    name: 'save_viewer_note',
    title: '視聴者のメモを保存する',
    description:
      '視聴者1人の記録に、配信者のメモを保存します。メモはまるごと置き換わります（前のメモに書き足すときは、search_viewers で読んだメモに続けて渡します）。userId には search_viewers が返した userId を指定します。',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'search_viewers が返した userId' },
        note: { type: 'string', description: '保存するメモ（空にするとメモを消す）' },
      },
      required: ['userId', 'note'],
    },
    execute: async (input) => {
      const userId = readString(input, 'userId')
      const note = readString(input, 'note')
      return `メモを保存しました: ${await apis.viewerApi.saveNote(userId, note)}`
    },
  },
  {
    name: 'get_llm_usage',
    title: 'LLMの使用状況',
    description:
      'LLM と判定用の Jev を呼んだ回数・失敗した回数・トークン数・実費（米ドル）を、使う箇所ごとと全体の合計で、今日（UTC）と直近7日に分けて返します。',
    inputSchema: NO_INPUT,
    annotations: READ_ONLY,
    execute: async () => JSON.stringify(summarizeLlmUsage(await apis.llmApi.loadUsage(), now())),
  },
  {
    name: 'get_llm_credits',
    title: 'OpenRouterの残高',
    description: 'OpenRouter に入金した額・使った額・残り（米ドル）を返します。OpenRouter のAPIキーが設定されていなければエラーになります。',
    inputSchema: NO_INPUT,
    annotations: READ_ONLY,
    execute: async () => {
      // 鍵が無いと Worker が断るので、先に確かめて理由の分かる文面で返す（LLM のページと同じ順に読む）
      if (!(await apis.llmApi.load()).apiKeyConfigured) throw new Error('OpenRouter のAPIキーが設定されていないので、残高を読めません')
      return JSON.stringify(await apis.llmApi.loadCredits())
    },
  },
]
