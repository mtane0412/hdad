/**
 * ペロペロの描画（three.js の3Dと、上に重ねる2Dの文言と唾液の糸）
 *
 * 画面の奥から順に「相手のアイコン（丸く切り抜いた板）→ 舌 → 透明なガラス」を置き、舌がガラス越しにアイコンを舐める形で描く。
 * 舌は表（乳頭のブツブツ・溝・奥の苔）をカメラへ向けてガラスに押しつけ、押しつけたところは平たく広がる。最後の1回は舌先を丸めて
 * 巻き込み、裏の青い血管を見せる。舐めた跡（濡れた筋・泡・垂れ）はガラスの板に毎コマ描き直し、舌を離すときの唾液の糸は2Dの canvas に描く。
 *
 * - 舌の形は tongue-shape.ts、模様は texture.ts、舐め方と跡と糸は motion.ts が決める（どれも経過時間と種だけから決まる）
 * - 舌は濡れて見えるよう clearcoat を持つ物理ベースの材質にし、部屋の照り返し（RoomEnvironment）を映す。赤みが透ける感じは
 *   暗い赤の自己発光と、桃色の sheen で出す
 *
 * 背景は透明にし、配信画面の上にアイコンと舌が浮かぶように重ねる。
 *
 * 注意: 描画だけを受け持つのでテストを持たない（何をどこに出すかは motion.ts・tongue-shape.ts・texture.ts が決め、そちらをテストする）。
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  DataTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { createRandom } from '../core/background'
import type { LickCall } from './call'
import { salivaStringAt, trailsAt, type LickPlan, type LickScene, type SalivaTrail } from './motion'
import { tongueBottomTexture, tongueTopTexture } from './texture'
import { tongueSurfacePoint, type TonguePose } from './tongue-shape'

/** 画面に出す文字の書体（ツイスターと同じ） */
const FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif'
/** 2Dの大きさの基準にする画面の高さ（px）。配信画面（1080）に合わせて、文字の大きさをこの比で拡大縮小する */
const BASE_HEIGHT = 1080
/** 文言の文字の大きさと縁取りの太さ（BASE_HEIGHT のときの px） */
const TITLE_FONT = 72
const OUTLINE = 8
/** カメラの視野角（度）と、アイコンからの距離。アイコン（直径2）が画面の高さの6割ほどに映る */
const CAMERA_FOV = 30
const CAMERA_DISTANCE = 6
/** アイコンの半径（3Dの単位）と、テクスチャの画素数・縁の色 */
const ICON_RADIUS = 1
const ICON_TEXTURE_SIZE = 512
const ICON_BORDER_COLOR = '#ffffff'
/** 頭文字の顔の地の色 */
const INITIAL_BACKGROUND = '#8e44ad'
/** 舐めた跡を描くガラスの位置（アイコンから手前への距離）と、跡の絵の画素数 */
const GLASS_Z = 0.3
const SALIVA_TEXTURE_SIZE = 512
/** 舌の長さ（3Dの単位） */
const TONGUE_LENGTH = 2.9
/** 舌の板を張る刻みの数（長さの向き・幅の向き） */
const TONGUE_SEGMENTS_U = 48
const TONGUE_SEGMENTS_V = 20
/** 舌の模様の画素数と種（模様は呼び出しごとに変えない） */
const TONGUE_TEXTURE_SIZE = 256
const TONGUE_TEXTURE_SEED = 337
/** 部屋の照り返しの強さ（強すぎると舌が白っぽく飛ぶ） */
const ENVIRONMENT_INTENSITY = 0.55
/** 舌の凹凸の強さ */
const TONGUE_BUMP_SCALE = 4
/** 舌先が進む範囲（アイコンの下端の少し下から、上端の少し上まで） */
const TONGUE_TIP_FROM = -ICON_RADIUS * 1.3
const TONGUE_TIP_TO = ICON_RADIUS * 1.15
/** 舌の中心の、ガラスからの距離（押しつけていないとき・押しつけきったとき） */
const TONGUE_GAP_RELAXED = 0.1
const TONGUE_GAP_PRESSED = 0.04
/** 舌を引っ込めるときに、下へ・奥へ下げる距離 */
const RETRACT_DROP = 1.6
const RETRACT_BACK = 0.15
/** 舌の幅の向きの、跡の半分の幅（3Dの単位） */
const TRAIL_HALF_WIDTH = 0.36
/** すくう回で、アイコンを持ち上げる高さと傾ける角度（ラジアン） */
const SCOOP_LIFT = 0.15
const SCOOP_TILT = 0.3
/** 唾液の糸の太さ（BASE_HEIGHT のときの px。伸びはじめ・切れる直前）と、たるみ（3Dの単位） */
const STRING_WIDTH_FROM = 22
const STRING_WIDTH_TO = 2
const STRING_SAG = 0.3
/** 糸が付いている高さの上限（3Dの単位。アイコンの上端より少し下） */
const STRING_ANCHOR_MAX = ICON_RADIUS * 0.85
/** 糸を何本引くか（1本ずつ横へずらし、たるみと太さを変える） */
const STRING_STRANDS = [
  { shift: 0, sag: 1, width: 1 },
  { shift: -0.07, sag: 1.5, width: 0.45 },
  { shift: 0.09, sag: 0.7, width: 0.3 },
] as const
/** 跡1本に浮かべる泡の数 */
const BUBBLES_PER_TRAIL = 22
/** 跡1本に光らせる照りの数 */
const SHINES_PER_TRAIL = 3

/** その時刻に描くもの */
export interface LickFrame {
  readonly call: LickCall
  readonly plan: LickPlan
  readonly scene: LickScene
  readonly elapsedMs: number
}

export interface LickRenderer {
  /** 相手のアイコンを貼る。画像が無ければ名前の頭文字の顔にする */
  setIcon(call: LickCall, image: HTMLImageElement | null): void
  /** 1コマ描く。frame が null なら何も映さない */
  render(hud: CanvasRenderingContext2D, width: number, height: number, frame: LickFrame | null): void
}

/** 名前の頭文字（アイコンが無いときの顔に使う） */
const initialOf = (name: string): string => Array.from(name)[0] ?? '?'

/** 2D の描画コンテキストを取り出す */
const context2d = (canvas: HTMLCanvasElement, purpose: string): CanvasRenderingContext2D => {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(`${purpose}を描く canvas の2D描画コンテキストを取得できませんでした`)
  return ctx
}

/** アイコンを丸く切り抜いた絵を描く。画像が無ければ名前の頭文字の顔にする */
const drawIcon = (image: HTMLImageElement | null, name: string): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_TEXTURE_SIZE
  canvas.height = ICON_TEXTURE_SIZE
  const ctx = context2d(canvas, 'アイコンの絵')
  const half = ICON_TEXTURE_SIZE / 2
  const border = ICON_TEXTURE_SIZE * 0.03
  ctx.beginPath()
  ctx.arc(half, half, half - border / 2, 0, Math.PI * 2)
  ctx.fillStyle = INITIAL_BACKGROUND
  ctx.fill()
  ctx.save()
  ctx.clip()
  if (image === null) {
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${ICON_TEXTURE_SIZE * 0.5}px ${FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(initialOf(name), half, half)
  } else {
    ctx.drawImage(image, 0, 0, ICON_TEXTURE_SIZE, ICON_TEXTURE_SIZE)
  }
  ctx.restore()
  ctx.lineWidth = border
  ctx.strokeStyle = ICON_BORDER_COLOR
  ctx.stroke()
  return canvas
}

/** 画素の並びを three.js のテクスチャにする */
const dataTexture = (data: Uint8ClampedArray, size: number, color: boolean): DataTexture => {
  const texture = new DataTexture(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), size, size, RGBAFormat)
  if (color) texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

/**
 * 舌の板（表と裏の2面）を作る。頂点の位置は毎コマ updateTongue で書き換えるので、ここでは並びと貼り方（UV）だけを決める。
 * 表と裏は左右の端（v = ±1）と舌先（u = 1）で厚みが 0 になり、閉じた形になる。
 */
const createTongueGeometry = (): BufferGeometry => {
  const columns = TONGUE_SEGMENTS_V + 1
  const rows = TONGUE_SEGMENTS_U + 1
  const perSide = columns * rows
  const positions = new Float32Array(perSide * 2 * 3)
  const uvs = new Float32Array(perSide * 2 * 2)
  const indices: number[] = []
  for (const [sideIndex, side] of (['top', 'bottom'] as const).entries()) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const vertex = sideIndex * perSide + row * columns + column
        uvs[vertex * 2] = column / TONGUE_SEGMENTS_V
        uvs[vertex * 2 + 1] = row / TONGUE_SEGMENTS_U
        if (row === TONGUE_SEGMENTS_U || column === TONGUE_SEGMENTS_V) continue
        const a = vertex
        const b = vertex + 1
        const c = vertex + columns
        const d = vertex + columns + 1
        // 表は手前から見て反時計回り、裏は奥から見て反時計回りに張る（外向きの面にする）
        if (side === 'top') indices.push(a, b, d, a, d, c)
        else indices.push(a, d, b, a, c, d)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  const sideIndexCount = indices.length / 2
  geometry.addGroup(0, sideIndexCount, 0)
  geometry.addGroup(sideIndexCount, sideIndexCount, 1)
  return geometry
}

/** 舌の頂点を、その時刻の様子の形へ書き換える */
const updateTongue = (geometry: BufferGeometry, pose: TonguePose): void => {
  const position = geometry.getAttribute('position')
  const columns = TONGUE_SEGMENTS_V + 1
  const rows = TONGUE_SEGMENTS_U + 1
  for (const [sideIndex, side] of (['top', 'bottom'] as const).entries()) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const point = tongueSurfacePoint(row / TONGUE_SEGMENTS_U, (column / TONGUE_SEGMENTS_V) * 2 - 1, side, pose)
        position.setXYZ(sideIndex * columns * rows + row * columns + column, point.x, point.y, point.z)
      }
    }
  }
  position.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
}

/** 舌先の高さ（アイコンの板の上の y）を、舐め上げた進み具合から求める */
const tipHeightAt = (reach: number): number => TONGUE_TIP_FROM + (TONGUE_TIP_TO - TONGUE_TIP_FROM) * reach

/** 舐める横の位置（アイコンの幅を1としたずれ）を、アイコンの板の上の x にする */
const tipXAt = (offset: number): number => offset * ICON_RADIUS * 2

/**
 * 舐めた跡（濡れた筋・泡・垂れ）をガラスの絵に描く。絵の真ん中がアイコンの中心で、端がアイコンの縁。
 * 跡は経過時間と種だけから決まる（trailsAt）ので、毎コマ描き直す。
 */
const drawSaliva = (ctx: CanvasRenderingContext2D, trails: readonly SalivaTrail[]): void => {
  const size = SALIVA_TEXTURE_SIZE
  /** アイコンの板の上の位置（-1〜1）を絵の画素へ */
  const toPixel = (x: number, y: number): { x: number; y: number } => ({ x: ((x / ICON_RADIUS + 1) / 2) * size, y: ((1 - y / ICON_RADIUS) / 2) * size })
  const scale = size / (ICON_RADIUS * 2)
  ctx.clearRect(0, 0, size, size)
  ctx.save()
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.clip()
  for (const [index, trail] of trails.entries()) {
    const top = toPixel(tipXAt(trail.offset), tipHeightAt(trail.toReach))
    const bottom = toPixel(tipXAt(trail.offset), tipHeightAt(0))
    const halfWidth = TRAIL_HALF_WIDTH * scale
    const wet = trail.wetness
    const random = createRandom(index * 7919 + 1)
    // 濡れた筋（ぬらっとした薄い膜）。少しずつずらした楕円を重ねて、縁がよれたむらのある膜にする
    const length = bottom.y - top.y
    const blobs = Math.max(1, Math.ceil(length / (halfWidth * 0.35)))
    for (let count = 0; count <= blobs; count += 1) {
      const y = top.y + (length * count) / blobs
      const x = top.x + (random() - 0.5) * halfWidth * 0.3
      ctx.beginPath()
      ctx.ellipse(x, y, halfWidth * (0.75 + random() * 0.25), halfWidth * 0.6, 0, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 238, 232, ${0.07 * wet})`
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.05 * wet})`
      ctx.lineWidth = 2
      ctx.stroke()
    }
    // 照り（膜の上に光る、縦長の細い白）
    for (let count = 0; count < SHINES_PER_TRAIL; count += 1) {
      const y = top.y + length * random()
      const x = top.x + (random() - 0.5) * halfWidth * 1.2
      ctx.beginPath()
      ctx.ellipse(x, y, 2 + random() * 2.5, 6 + random() * 14, (random() - 0.5) * 0.3, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.55 * wet})`
      ctx.fill()
    }
    // 泡（跡ごとに決まった並び。舌を離した上のほうに寄せて固まらせる）
    for (let count = 0; count < BUBBLES_PER_TRAIL; count += 1) {
      const along = 1 - random() ** 2 * 0.8
      const across = random() * 2 - 1
      const radius = 1.5 + random() ** 2 * 6
      const y = bottom.y + (top.y - bottom.y) * along
      const x = top.x + across * halfWidth * 0.85
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.25 * wet})`
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 * wet})`
      ctx.lineWidth = 1.2
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x - radius * 0.35, y - radius * 0.35, radius * 0.3, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * wet})`
      ctx.fill()
    }
    // 垂れ（跡の途中から下へ細く伸び、先にしずくを付ける）
    for (const drip of trail.drips) {
      if (drip.length <= 0 || drip.at > trail.toReach) continue
      const from = toPixel(tipXAt(trail.offset) + drip.side * TRAIL_HALF_WIDTH, tipHeightAt(drip.at))
      const to = { x: from.x, y: from.y + (tipHeightAt(drip.at) - tipHeightAt(drip.at - drip.length)) * scale }
      const stream = ctx.createLinearGradient(0, from.y, 0, to.y)
      stream.addColorStop(0, `rgba(255, 250, 245, ${0.55 * wet})`)
      stream.addColorStop(1, `rgba(255, 250, 245, ${0.8 * wet})`)
      ctx.lineCap = 'round'
      // 明るい背景のアイコンでも見えるよう、薄い影を下に敷く
      ctx.strokeStyle = 'rgba(60, 20, 30, 0.18)'
      ctx.lineWidth = 9
      ctx.beginPath()
      ctx.moveTo(from.x + 1.5, from.y)
      ctx.lineTo(to.x + 1.5, to.y)
      ctx.stroke()
      ctx.strokeStyle = stream
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.ellipse(to.x, to.y, 7, 10, 0, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 252, 248, ${0.75 * wet})`
      ctx.fill()
      ctx.beginPath()
      ctx.arc(to.x - 2.5, to.y - 3, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.95 * wet})`
      ctx.fill()
    }
  }
  ctx.restore()
}

/** 3Dの位置を、2Dの canvas の座標（CSS の px）へ映す */
const projectToScreen = (camera: PerspectiveCamera, point: Vector3, width: number, height: number): { x: number; y: number } => {
  const projected = point.clone().project(camera)
  return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height }
}

/**
 * 舌を離すときの唾液の糸を、2Dの canvas に描く（伸びるほど細く、たるむ）。
 * 糸はガラスの舌を離したところから、下へ・奥へ引っ込んでいく舌先まで張る（舌を引っ込める動きと同じ向き・速さで伸ばす）。
 */
const drawSalivaString = (ctx: CanvasRenderingContext2D, frame: LickFrame, camera: PerspectiveCamera, width: number, height: number, unit: number): void => {
  const string = salivaStringAt(frame.plan, frame.elapsedMs)
  if (string === null) return
  const x = tipXAt(string.offset)
  const anchorY = Math.min(tipHeightAt(string.anchorReach), STRING_ANCHOR_MAX)
  const lineWidth = (STRING_WIDTH_FROM + (STRING_WIDTH_TO - STRING_WIDTH_FROM) * string.stretch) * unit
  ctx.lineCap = 'round'
  for (const strand of STRING_STRANDS) {
    const anchor = new Vector3(x + strand.shift, anchorY, GLASS_Z)
    const free = new Vector3(x + strand.shift * 0.4, anchorY - RETRACT_DROP * string.stretch, GLASS_Z - TONGUE_GAP_RELAXED - RETRACT_BACK * string.stretch)
    const middle = anchor.clone().lerp(free, 0.5)
    middle.y -= STRING_SAG * strand.sag * string.stretch
    const [from, control, to] = [anchor, middle, free].map((point) => projectToScreen(camera, point, width, height))
    if (from === undefined || control === undefined || to === undefined) continue
    for (const [color, scale] of [
      ['rgba(255, 240, 236, 0.5)', 1],
      ['rgba(255, 255, 255, 0.9)', 0.3],
    ] as const) {
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(lineWidth * strand.width * scale, 0.6)
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.quadraticCurveTo(control.x, control.y, to.x, to.y)
      ctx.stroke()
    }
    // 伸びた糸の途中にたまる、唾液の玉
    if (string.stretch > 0.35) {
      const t = 0.55
      const beadX = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * to.x
      const beadY = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * to.y
      ctx.beginPath()
      ctx.ellipse(beadX, beadY, 5 * unit * strand.width + 2, 8 * unit * strand.width + 3, 0, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 250, 245, 0.75)'
      ctx.fill()
    }
  }
}

/** 縁取りした文字を描く（配信画面のどんな背景の上でも読めるように） */
const outlinedText = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, unit: number): void => {
  ctx.font = `bold ${TITLE_FONT * unit}px ${FONT_FAMILY}`
  ctx.lineJoin = 'round'
  ctx.lineWidth = OUTLINE * unit
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, x, y)
}

/**
 * ペロペロの描画を作る。
 *
 * @throws WebGL を使えない場合（three.js の WebGLRenderer が投げる）
 */
export const createLickRenderer = (glCanvas: HTMLCanvasElement): LickRenderer => {
  const renderer = new WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true })
  renderer.setClearColor(0x000000, 0)

  const scene = new Scene()
  // 濡れたテカリに映り込ませる部屋の照り返し
  const pmrem = new PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = ENVIRONMENT_INTENSITY
  pmrem.dispose()
  scene.add(new HemisphereLight(0xffffff, 0x553344, 0.45))
  const key = new DirectionalLight(0xffffff, 2.4)
  key.position.set(-1.5, 2.5, 4)
  scene.add(key)
  const rim = new DirectionalLight(0xffd0d8, 1.6)
  rim.position.set(2, 3, -1)
  scene.add(rim)

  const world = new Group()
  const iconMaterial = new MeshBasicMaterial({ transparent: true })
  const icon = new Mesh(new CircleGeometry(ICON_RADIUS, 64), iconMaterial)
  world.add(icon)

  const top = tongueTopTexture(TONGUE_TEXTURE_SIZE, TONGUE_TEXTURE_SEED)
  const bottom = tongueBottomTexture(TONGUE_TEXTURE_SIZE, TONGUE_TEXTURE_SEED)
  const wet = { clearcoat: 1, clearcoatRoughness: 0.05, sheen: 0.25, sheenColor: '#ff8098', sheenRoughness: 0.5, emissive: '#2a0008' } as const
  const topMaterial = new MeshPhysicalMaterial({
    ...wet,
    map: dataTexture(top.color, TONGUE_TEXTURE_SIZE, true),
    bumpMap: dataTexture(top.bump, TONGUE_TEXTURE_SIZE, false),
    bumpScale: TONGUE_BUMP_SCALE,
    roughness: 0.42,
  })
  const bottomMaterial = new MeshPhysicalMaterial({ ...wet, map: dataTexture(bottom.color, TONGUE_TEXTURE_SIZE, true), roughness: 0.3 })
  const tongueGeometry = createTongueGeometry()
  const tongue = new Mesh(tongueGeometry, [topMaterial, bottomMaterial])
  world.add(tongue)

  // 舐めた跡を描くガラスの板。透視でアイコンと同じ大きさに映るよう、手前に出したぶん小さくする
  const salivaCanvas = document.createElement('canvas')
  salivaCanvas.width = SALIVA_TEXTURE_SIZE
  salivaCanvas.height = SALIVA_TEXTURE_SIZE
  const salivaContext = context2d(salivaCanvas, '舐めた跡')
  const salivaTexture = new CanvasTexture(salivaCanvas)
  salivaTexture.colorSpace = SRGBColorSpace
  const glass = new Mesh(new CircleGeometry((ICON_RADIUS * (CAMERA_DISTANCE - GLASS_Z)) / CAMERA_DISTANCE, 64), new MeshBasicMaterial({ map: salivaTexture, transparent: true, depthWrite: false }))
  glass.position.z = GLASS_Z
  world.add(glass)
  scene.add(world)

  const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 50)
  camera.position.set(0, 0, CAMERA_DISTANCE)
  camera.lookAt(0, 0, 0)
  let size = { width: 0, height: 0, ratio: 0 }
  /** アイコンのテクスチャを作った呼び出し。同じ呼び出しのあいだは作り直さない */
  let iconFor: LickCall | null = null

  const setIcon: LickRenderer['setIcon'] = (call, image) => {
    iconFor = call
    const texture = new CanvasTexture(drawIcon(image, call.target.name))
    texture.colorSpace = SRGBColorSpace
    iconMaterial.map?.dispose()
    iconMaterial.map = texture
    iconMaterial.needsUpdate = true
  }

  const render: LickRenderer['render'] = (hud, width, height, frame) => {
    const ratio = window.devicePixelRatio
    if (size.width !== width || size.height !== height || size.ratio !== ratio) {
      renderer.setPixelRatio(ratio)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      size = { width, height, ratio }
    }
    world.visible = frame !== null && frame.scene.phase !== 'done'
    if (frame === null || !world.visible) {
      renderer.render(scene, camera)
      return
    }
    if (iconFor !== frame.call) setIcon(frame.call, null)

    const opacity = frame.scene.iconOpacity
    iconMaterial.opacity = opacity
    glass.material.opacity = opacity
    drawSaliva(salivaContext, trailsAt(frame.plan, frame.elapsedMs))
    salivaTexture.needsUpdate = true

    const state = frame.scene.tongue
    tongue.visible = state !== null && state.extension > 0
    // すくう回では、丸めた舌先にアイコンが持ち上げられる
    const scoop = state?.curl ?? 0
    icon.position.y = SCOOP_LIFT * scoop
    icon.rotation.x = -SCOOP_TILT * scoop
    if (state !== null) {
      updateTongue(tongueGeometry, { length: TONGUE_LENGTH, squash: state.squash, curl: state.curl })
      // 舌先の高さは進み具合で決め、出し具合が足りないぶんだけ下へ・奥へ引っ込める
      const retract = 1 - state.extension
      const gap = TONGUE_GAP_RELAXED + (TONGUE_GAP_PRESSED - TONGUE_GAP_RELAXED) * state.squash
      tongue.position.set(tipXAt(state.offset), tipHeightAt(state.reach) - RETRACT_DROP * retract, GLASS_Z - gap - RETRACT_BACK * retract)
      tongue.rotation.z = state.tilt
    }
    renderer.render(scene, camera)

    const unit = height / BASE_HEIGHT
    hud.globalAlpha = opacity
    drawSalivaString(hud, frame, camera, width, height, unit)
    hud.textAlign = 'center'
    hud.textBaseline = 'middle'
    outlinedText(hud, `${frame.call.target.name} さんをペロペロ`, width / 2, height * 0.1, unit)
    hud.globalAlpha = 1
  }

  return { setIcon, render }
}
