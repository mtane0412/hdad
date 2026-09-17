/**
 * 背景レジストリ
 *
 * 公開する背景の一覧。背景を追加するときは、ここへの登録と
 * backgrounds/<id>/index.html の作成を両方行う（対応は registry.test.ts が検証する）。
 */
import type { BackgroundDefinition } from '../core/background'
import { aurora } from './aurora'
import { contour } from './contour'
import { grid } from './grid'
import { halftone } from './halftone'
import { motes } from './motes'
import { stripes } from './stripes'
import { truchet } from './truchet'
import { waves } from './waves'

export const backgrounds: readonly BackgroundDefinition[] = [
  aurora,
  contour,
  grid,
  halftone,
  motes,
  stripes,
  truchet,
  waves,
]
