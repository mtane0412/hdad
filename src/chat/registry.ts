/**
 * チャットボックスのレジストリ
 *
 * デザインを追加するときは、ここへの登録に加えて src/chat/<id>.css を作り、src/overlay/overlay.css に @import を足す。
 * Workers 静的アセットはURLのパスごとに実ファイルが必要なため、両者の対応は registry.test.ts で検証している。
 */
import { bubble } from './bubble'
import { card } from './card'
import type { ChatDefinition } from './definition'
import { plain } from './plain'
import { sticker } from './sticker'
import { terminal } from './terminal'

/** 公開しているチャットボックスの一覧（名前順） */
export const chats: readonly ChatDefinition[] = [bubble, card, plain, sticker, terminal]
