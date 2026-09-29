/**
 * 手書きのプレビュー用のサンプル
 *
 * 管理画面（/overlay/）のプレビューでは中継先へつながず、この線を描いて見せる（つないでも、そのとき
 * 配信者が描いていなければ何も出ず、置いた場所と大きさを確かめられないため）。
 * 色と太さも混ぜてあるので、選べる道具の見え方をここで確かめられる。
 */
import type { Stroke } from './strokes'

/** 丸く囲んで矢印で指した、よくある注釈の形 */
export const demoStrokes: readonly Stroke[] = [
  {
    id: '囲み',
    color: 'yellow',
    width: 'medium',
    points: Array.from({ length: 33 }, (_, 番号) => {
      const 角度 = (番号 / 32) * Math.PI * 2
      return { x: 0.38 + Math.cos(角度) * 0.16, y: 0.42 + Math.sin(角度) * 0.2 }
    }),
  },
  {
    id: '矢印の軸',
    color: 'red',
    width: 'bold',
    points: [
      { x: 0.86, y: 0.78 },
      { x: 0.6, y: 0.56 },
    ],
  },
  {
    id: '矢印の羽',
    color: 'red',
    width: 'bold',
    points: [
      { x: 0.6, y: 0.7 },
      { x: 0.6, y: 0.56 },
      { x: 0.73, y: 0.57 },
    ],
  },
]
