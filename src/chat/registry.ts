/**
 * チャットボックスのレジストリ
 *
 * デザインを追加するときは、ここへの登録に加えて chat/<id>/index.html と src/chat/<id>.css も作成する。
 * GitHub PagesはURLのパスごとに実ファイルが必要なため、両者の対応は registry.test.ts で検証している。
 */
import { bubble } from './bubble'
import type { ChatDefinition } from './definition'

/** 公開しているチャットボックスの一覧（名前順） */
export const chats: readonly ChatDefinition[] = [bubble]
