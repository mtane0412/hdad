/**
 * サイドスーパーのパラメータ宣言（寄せる向き）
 *
 * 単独のオーバーレイ（side-super/overlay/index.html）と合成ページ（overlay/stage/index.html）の両方が
 * 同じ向きの指定を受け取るので、スキーマの宣言をここ1か所に置いて共有する。
 * 単独のオーバーレイはこれに ?key= と ?demo= を足したスキーマを使い、合成ページはレイヤーの
 * パラメータ（構成が持つクエリ文字列）としてこれだけを使う。
 */
import type { ParamSchema } from '../core/params'
import { DEFAULT_SIDE_SUPER_POSITION } from './url'

/** 寄せる向きの指定。合成ページでは箱の中のどちら側に寄せるかになる */
export const sideSuperParamSchema = {
  position: {
    type: 'string',
    default: DEFAULT_SIDE_SUPER_POSITION,
    pattern: /^(?:left|right)$/,
    example: 'left または right',
    description: 'どちら側に寄せるか（left: 左上、right: 右上）',
  },
} as const satisfies ParamSchema
