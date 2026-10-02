/**
 * 拡張の設定ページからサービスワーカーへの頼みの形
 *
 * 設定ページ（options.ts）は映さないサイトの一覧を Worker から直接読み書きせず、サービスワーカー（background.ts）に頼む。
 * サービスワーカーが一覧を覚え直し、映しているタブにもすぐ反映できるようにするため（controller.ts の handleSettingsRequest）。
 *
 * chrome.runtime.sendMessage は拡張の中のすべての画面に届くので、あて先（target）を付けて読み分ける。
 *
 * 注意: 設定ページは型だけを使い、あて先の値を直接書く（設定ページとサービスワーカーの両方から実行時に読み込むと、
 * ビルドで共有のファイルができて zip に入らない。extension/vite.config.ts）。
 */
import { isRecord } from './guards'

/** サービスワーカーあての、設定ページからの頼みに付けるあて先 */
export const SETTINGS_REQUEST_TARGET = 'settings'

/** 設定ページからの頼み */
export type SettingsRequest =
  /** 一覧を Worker から読み直す */
  | { type: 'list' }
  /** 手で入力したホスト名を登録する（形の検証は Worker が持つ） */
  | { type: 'add'; host: string }
  /** ホスト名を一覧から外す */
  | { type: 'remove'; host: string }

/** 送るときの形（あて先を付ける） */
export type SettingsRequestMessage = SettingsRequest & { target: typeof SETTINGS_REQUEST_TARGET }

/** 頼みへの返事。うまくいったら変えたあとの一覧を、失敗したら理由を返す */
export type SettingsReply = { ok: true; hosts: string[] } | { ok: false; message: string }

const INVALID = '設定ページからの頼みの形が想定と違います'

/**
 * 届いた連絡を読む。
 *
 * @returns 設定ページからの頼みでなければ null（offscreen document からの知らせなど）
 * @throws あて先が合っているのに形が違う場合（拡張の版が食い違っている）
 */
export const parseSettingsRequest = (value: unknown): SettingsRequest | null => {
  if (!isRecord(value) || value.target !== SETTINGS_REQUEST_TARGET) return null
  if (value.type === 'list') return { type: 'list' }
  if ((value.type === 'add' || value.type === 'remove') && typeof value.host === 'string') return { type: value.type, host: value.host }
  throw new Error(INVALID)
}
