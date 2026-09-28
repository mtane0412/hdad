/**
 * サイドスーパーのパラメータ宣言（寄せる向き）
 *
 * 合成ページ（overlay/stage/index.html）がレイヤーのパラメータ（構成が持つクエリ文字列）として読む。
 * 向きは配信者がオーバーレイの管理画面（/overlay/）で選ぶので、スキーマの宣言はここ1か所に置く。
 */
import type { ParamSchema } from '../core/params'

/** 画面のどちら側に出すか */
export type SideSuperPosition = 'left' | 'right'

/** 寄せる向きの既定。パラメータに書かなければこちらになる */
export const DEFAULT_SIDE_SUPER_POSITION: SideSuperPosition = 'left'

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
