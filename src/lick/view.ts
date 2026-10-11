/**
 * ペロペロの描画（three.js の3Dと、上に重ねる2Dの文言）
 *
 * 3Dは WebGL の canvas に、相手のアイコン（丸く切り抜いた板）と、下から伸びて舐め上げる舌を描く。
 * 舌はいまは仮の形（つぶした楕円体）で、場面（motion.ts の lickSceneAt）の進み具合・出し具合・横の位置・傾きをそのまま映す。
 * 2Dは別の canvas に、誰を舐めているかの文言を描く。
 *
 * 背景は透明にし、配信画面の上にアイコンと舌が浮かぶように重ねる。
 *
 * 注意: 描画だけを受け持つのでテストを持たない（何をどこに出すかは motion.ts が決め、そちらをテストする）。
 */
import {
  CanvasTexture,
  CircleGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'
import type { LickCall } from './call'
import type { LickScene } from './motion'

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
/** 舌の大きさ（3Dの単位。幅・長さ・厚み）と色 */
const TONGUE_WIDTH = 0.42
const TONGUE_LENGTH = 1.7
const TONGUE_THICKNESS = 0.14
const TONGUE_COLOR = '#d9566b'
/** 舌先が進む範囲（アイコンの下端の少し下から、上端の少し上まで） */
const TONGUE_TIP_FROM = -ICON_RADIUS * 1.3
const TONGUE_TIP_TO = ICON_RADIUS * 1.25
/** 舌をアイコンの手前へ出す距離（アイコンにめり込まないように） */
const TONGUE_FRONT = 0.12

/** その時刻に描くもの */
export interface LickFrame {
  readonly call: LickCall
  readonly scene: LickScene
}

export interface LickRenderer {
  /** 相手のアイコンを貼る。画像が無ければ名前の頭文字の顔にする */
  setIcon(call: LickCall, image: HTMLImageElement | null): void
  /** 1コマ描く。frame が null なら何も映さない */
  render(hud: CanvasRenderingContext2D, width: number, height: number, frame: LickFrame | null): void
}

/** 名前の頭文字（アイコンが無いときの顔に使う） */
const initialOf = (name: string): string => Array.from(name)[0] ?? '?'

/** アイコンを丸く切り抜いた絵を描く。画像が無ければ名前の頭文字の顔にする */
const drawIcon = (image: HTMLImageElement | null, name: string): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_TEXTURE_SIZE
  canvas.height = ICON_TEXTURE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('アイコンの絵を描く canvas の2D描画コンテキストを取得できませんでした')
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
  scene.add(new HemisphereLight(0xffffff, 0x553344, 1.2))
  const key = new DirectionalLight(0xffffff, 2.2)
  key.position.set(-1.5, 2.5, 4)
  scene.add(key)

  const world = new Group()
  const iconMaterial = new MeshBasicMaterial({ transparent: true })
  const icon = new Mesh(new CircleGeometry(ICON_RADIUS, 64), iconMaterial)
  world.add(icon)

  // 舌はつぶした楕円体。原点を舌の中心に置き、長さの向き（y）に伸び縮みさせる
  const tongue = new Mesh(new SphereGeometry(0.5, 32, 24), new MeshStandardMaterial({ color: TONGUE_COLOR, roughness: 0.35, metalness: 0 }))
  world.add(tongue)
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

    iconMaterial.opacity = frame.scene.iconOpacity
    const state = frame.scene.tongue
    tongue.visible = state !== null && state.extension > 0
    if (state !== null) {
      // 舌先の高さは進み具合だけで決め、出し具合のぶん根元側へ縮める（舌先がアイコンをなぞる位置は変えない）
      const length = TONGUE_LENGTH * state.extension
      const tipY = TONGUE_TIP_FROM + (TONGUE_TIP_TO - TONGUE_TIP_FROM) * state.reach
      const x = state.offset * ICON_RADIUS * 2
      tongue.scale.set(TONGUE_WIDTH, Math.max(length, 1e-3), TONGUE_THICKNESS)
      tongue.rotation.z = state.tilt
      // 傾けても舌先の位置が変わらないよう、舌先から長さの半分だけ傾きの向きへ戻した位置に中心を置く
      tongue.position.set(x + Math.sin(state.tilt) * (length / 2), tipY - Math.cos(state.tilt) * (length / 2), TONGUE_FRONT)
    }
    renderer.render(scene, camera)

    const unit = height / BASE_HEIGHT
    hud.globalAlpha = frame.scene.iconOpacity
    hud.textAlign = 'center'
    hud.textBaseline = 'middle'
    outlinedText(hud, `${frame.call.target.name} さんをペロペロ`, width / 2, height * 0.1, unit)
    hud.globalAlpha = 1
  }

  return { setIcon, render }
}
