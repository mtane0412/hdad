/**
 * VRMのマスコットのパラメータ宣言（髪や服を揺らすか）
 *
 * 合成ページ（overlay/stage/index.html）が素材のパラメータ（構成が持つクエリ文字列）として読み、
 * 配信者がオーバーレイの管理画面（/overlay/）で切り替える。スキーマの宣言はここ1か所に置く。
 *
 * 注意: 揺らす（SpringBone を使う）か硬いままにするかを OBS で見比べて決めるための一時的な切り替え（issue #359）。
 * どちらにするか決めたら、このパラメータは消して決めたほうだけを残す（docs/decisions/vrm.md）。
 */
import type { ParamSchema } from '../core/params'

export const vrmParamSchema = {
  spring: {
    type: 'boolean',
    default: true,
    description: '髪や服を揺らす（揺らすか硬いままにするかを OBS で見比べるための一時的な切り替え）',
  },
} as const satisfies ParamSchema
