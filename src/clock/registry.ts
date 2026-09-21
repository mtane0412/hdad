/**
 * 時計のレジストリ
 *
 * 時計を追加するときは、ここへの登録に加えて clock/<id>/index.html も作成する。
 * Workers 静的アセットはURLのパスごとに実ファイルが必要なため、両者の対応は registry.test.ts で検証している。
 * 時計も壁紙と同じ「canvas 1枚に描く素材」なので、定義の型は core/background.ts のものを共用する。
 */
import type { BackgroundDefinition } from '../core/background'
import { analog } from './analog'
import { digital } from './digital'

/** 公開している時計の一覧（名前順） */
export const clocks: readonly BackgroundDefinition[] = [analog, digital]
