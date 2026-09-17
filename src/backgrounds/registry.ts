/**
 * 背景レジストリ
 *
 * 公開する背景の一覧。背景を追加するときは、ここへの登録と
 * backgrounds/<id>/index.html の作成を両方行う（対応は registry.test.ts が検証する）。
 */
import type { BackgroundDefinition } from '../core/background'
import { aurora } from './aurora'
import { contour } from './contour'
import { halftone } from './halftone'
import { motes } from './motes'

export const backgrounds: readonly BackgroundDefinition[] = [aurora, contour, halftone, motes]
