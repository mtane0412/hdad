/**
 * WebMCP で登録する、配信に直接出る操作のツール（issue #280 の段階2）
 *
 * チャットへの送信（配信者として・ボットとして）・注目コメントの取り上げをやめる・市町村紹介とツイスターの試し再生を
 * ツールにする。どれも視聴者の目に入り取り消せないので consequentialHint を付ける。
 *
 * どの操作も画面のボタンと同じ Worker の Api を呼ぶ（コメントビューアー・チャットボット・トリガーのページ）。
 * これらのページは操作の結果を自分の状態に持ち続けないか、持っていても次の操作で読み直すので、Api を直接呼んでよい。
 *
 * 注意: 注目コメントを外しても、開いているコメントビューアーの印はページを開き直すまで残る（ページが取り上げている
 *   発言を、開いたときに一度読むだけのため）。印を押せば読み直してから操作するので、壊れはしない。
 * 注意: 取り上げる側（発言を選んで注目コメントにする）は、発言の一覧をエージェントへどう渡すかが決まるまで作らない。
 */
import type { WebMCP } from 'webmcp-types'
import type { AdminApi } from '@/admin/api'
import type { BotApi } from '@/bot/api'
import type { CommentApi } from '@/comments/api'
import type { FocusApi } from '@/focus/api'
import { NO_INPUT, readChoice, readOptionalNumber, readOptionalString, readString } from './input'

/** 配信に出る操作のツールが使う Worker の Api（名前はアプリの枠の PageContext と同じ） */
export interface BroadcastApis {
  api: Pick<AdminApi, 'playTownTourDemo' | 'playTwisterDemo'>
  commentApi: Pick<CommentApi, 'send'>
  botApi: Pick<BotApi, 'sendMessage'>
  focusApi: FocusApi
}

/** チャットへ送るときの送り手 */
type ChatSender = 'streamer' | 'bot'
const CHAT_SENDERS: readonly ChatSender[] = ['streamer', 'bot']

/** 配信に直接出る操作なので、エージェントが実行前に配信者へ確かめられるよう印を付ける */
const CONSEQUENTIAL = { consequentialHint: true } as const

/**
 * 配信に出る操作のツールを作る。
 *
 * @param apis Worker の Api（webmcp-tools.tsx がアプリの枠から渡す）
 */
export const buildBroadcastTools = (apis: BroadcastApis): WebMCP.ModelContextTool[] => [
  {
    name: 'send_chat_message',
    title: 'チャットへ送る',
    description:
      '配信のチャットへ1通送ります。sender が streamer なら配信者本人として、bot ならチャットボットとして送ります。送った文は視聴者全員に見え、取り消せません。',
    inputSchema: {
      type: 'object',
      properties: {
        sender: { type: 'string', enum: CHAT_SENDERS, description: 'streamer（配信者本人）か bot（チャットボット）' },
        message: { type: 'string', description: '送る文' },
      },
      required: ['sender', 'message'],
    },
    annotations: CONSEQUENTIAL,
    execute: async (input) => {
      const sender = readChoice(input, 'sender', CHAT_SENDERS)
      const message = readString(input, 'message')
      // 文の検証（空・長すぎるなど）は Worker が行い、断られたらその理由がそのまま投げられる
      if (sender === 'streamer') {
        await apis.commentApi.send(message)
        return '配信者としてチャットへ送りました'
      }
      await apis.botApi.sendMessage(message)
      return 'ボットとしてチャットへ送りました'
    },
  },
  {
    name: 'clear_focus',
    title: '注目コメントの取り上げをやめる',
    description: '注目コメントの素材で取り上げている発言を外し、配信画面から消します。何も取り上げていなければ何もしません。',
    inputSchema: NO_INPUT,
    annotations: CONSEQUENTIAL,
    execute: async () => {
      if ((await apis.focusApi.load()) === null) return '注目コメントで取り上げている発言はありません'
      await apis.focusApi.save(null)
      return '注目コメントの取り上げをやめました'
    },
  },
  {
    name: 'play_town_tour_demo',
    title: '市町村紹介を試しに流す',
    description:
      'レイドを受けたときの市町村紹介を、試しに配信画面へ流します。userName にレイド元とみなす配信者のログイン名、viewers に連れてきた人数を渡すと、その配信者との共通点も作ります（どちらも省けます。省くと見本の名前で流します）。',
    inputSchema: {
      type: 'object',
      properties: {
        userName: { type: 'string', description: 'レイド元とみなす配信者の Twitch のログイン名' },
        viewers: { type: 'integer', minimum: 0, description: 'レイド元が連れてきたとみなす人数' },
      },
    },
    annotations: CONSEQUENTIAL,
    execute: async (input) => {
      const userName = readOptionalString(input, 'userName') ?? ''
      const viewers = readOptionalNumber(input, 'viewers') ?? null
      const headline = await apis.api.playTownTourDemo(userName, viewers)
      return `「${headline}」を送りました。オーバーレイに「市町村紹介」の素材を置いていれば流れます`
    },
  },
  {
    name: 'play_twister_demo',
    title: 'ツイスターを試しに流す',
    description:
      'レイドを受けたときのツイスターの対戦を、試しの相手と配信者で配信画面へ流します。userName に相手とみなす配信者のログイン名を渡すと、その人のアイコンで対戦します（省くと試しの相手で流します）。',
    inputSchema: {
      type: 'object',
      properties: {
        userName: { type: 'string', description: '相手とみなす配信者の Twitch のログイン名' },
      },
    },
    annotations: CONSEQUENTIAL,
    execute: async (input) => {
      const players = await apis.api.playTwisterDemo(readOptionalString(input, 'userName') ?? '')
      return `「${players}」の対戦を送りました。オーバーレイに「ツイスター」の素材を置いていれば流れます`
    },
  },
]
