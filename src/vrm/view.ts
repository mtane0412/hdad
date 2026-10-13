/**
 * VRMのマスコットの描画（three.js と @pixiv/three-vrm）
 *
 * 配信者がアップロードした VRM を読み込み、motion.ts が決めた場面（骨の回転・表情）をそのまま当てて描く。
 * 背景は透明にし、配信画面の上にキャラクターが浮かぶように重ねる。カメラはキャラクターの背の高さに合わせて引き、
 * 足もとが箱の下端の近くに来るようにする（キャラクターの大きさと置き場所は、配信者が素材の箱の大きさと位置で決める）。
 *
 * - 読み込んだ VRM は URL ごとに1つだけ持ち、同じ URL では読み直さない（反応のたびに数MB〜数十MBを読み直さないため）。
 *   読み込んでいる最中に同じ URL を求められたら、同じ読み込みを待つ。別の URL が届いたら、前のモデルを捨ててから読み込む。
 *   読み込みが重なったときは最後に求められたものだけを使い、それより前に求められて後から読み終えたモデルは捨てる（古いモデルで上書きしない）
 * - 骨は正規化された骨（normalized bone）に回転を当て、humanoid.update で実際の骨へ写す。vrm.update は呼ばない
 * - 髪や服の揺れ（SpringBone）は、揺らす設定のときだけ humanoid.update のあとに springBoneManager.update で進める。
 *   揺れ物は前のコマの状態から決まるので、経過時間だけから描く約束（docs/decisions/rendering.md）の例外である（issue #359）。
 *   1コマで進める時間は spring.ts の springStepSeconds で上限を設け、コマが落ちても遅れて追いつくだけにする。
 *   前のコマの時刻はここだけが持ち、モデルを読み替えたら持ち直す
 * - VRM 0.x のモデルは rotateVRM0 で向きをそろえるが、正規化された骨の軸は回したモデルの側に残るので、X と Z の回転を反転して当てる
 * - 読み込みにかかった時間は User Timing（performance.measure の「vrm-load」）に残す。OBS のブラウザソースの負荷を測るとき、
 *   開発者ツールの Performance で読める（issue #358 の検証）
 *
 * 注意: 描画だけを受け持つのでテストを持たない（何をどう動かすかは motion.ts が決め、そちらをテストする）。
 */
import { AmbientLight, Box3, DirectionalLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { VRM_BONES, type VrmScene } from './motion'
import { springStepSeconds } from './spring'

/** カメラの視野角（度） */
const CAMERA_FOV = 30
/** キャラクターの背の高さが、箱の高さのどれだけを占めるか */
const MODEL_SHARE = 0.8
/** 足もとを箱の下端からどれだけ上に置くか（箱の高さに対する割合） */
const FOOT_MARGIN = 0.05
/** にっこり・瞬き・口を「あ」に開ける表情の名前（VRM の既定の表情。VRM 0.x の名前は three-vrm がこの名前へ読み替える） */
const HAPPY_EXPRESSION = 'happy'
const BLINK_EXPRESSION = 'blink'
const MOUTH_EXPRESSION = 'aa'
/** 読み込みにかかった時間を残す User Timing の名前 */
const LOAD_MEASURE = 'vrm-load'

export interface VrmRenderer {
  /**
   * VRM を読み込んで、描くモデルにする。直前と同じ URL なら読み直さない。
   *
   * @throws 読み込めない・VRM として読めない場合
   */
  load(url: string): Promise<void>
  /**
   * 1コマ描く。
   *
   * @param scene その時刻の場面。モデルを読み込むまでは何も映さない
   * @param nowMs このコマを描く時刻（ミリ秒）。揺れ物を進める時間に使う
   */
  render(width: number, height: number, scene: VrmScene, nowMs: number): void
}

/** 読み込んだモデルと、それに合わせたカメラの置き方 */
interface LoadedModel {
  readonly url: string
  readonly vrm: VRM
  /** 背の高さ（メートル） */
  readonly height: number
  /** 正規化された骨の X・Z の回転の向き（VRM 0.x は −1） */
  readonly axisSign: number
}

/** 描画の設定 */
export interface VrmRendererOptions {
  /** 髪や服を揺らすか（SpringBone を使うか） */
  readonly spring: boolean
}

/**
 * VRMのマスコットの描画を作る。
 *
 * @throws WebGL を使えない場合（three.js の WebGLRenderer が投げる）
 */
export const createVrmRenderer = (glCanvas: HTMLCanvasElement, { spring }: VrmRendererOptions): VrmRenderer => {
  const renderer = new WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true })
  renderer.setClearColor(0x000000, 0)

  const scene = new Scene()
  scene.add(new AmbientLight(0xffffff, 0.6))
  const key = new DirectionalLight(0xffffff, 1.6)
  key.position.set(1, 2, 3)
  scene.add(key)

  const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 50)
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))

  let loaded: LoadedModel | null = null
  /** 読み込んでいる最中の URL と、その読み込み */
  let pending: { readonly url: string; readonly done: Promise<void> } | null = null
  /** 読み込みを求められた回数。読み終えたとき、自分が最後に求められた読み込みかを見分けるのに使う */
  let generation = 0
  /** 揺れ物を前に進めたコマの時刻（ミリ秒）。まだ進めていなければ null */
  let lastSpringMs: number | null = null
  let size = { width: 0, height: 0, ratio: 0 }

  const load: VrmRenderer['load'] = (url) => {
    if (loaded?.url === url) return Promise.resolve()
    if (pending?.url === url) return pending.done
    generation += 1
    const done = loadModel(url, generation).finally(() => {
      if (pending?.done === done) pending = null
    })
    pending = { url, done }
    return done
  }

  /**
   * VRM を読み込み、最後に求められた読み込みであれば描くモデルにする。
   *
   * @param requested この読み込みを求めたときの世代
   */
  const loadModel = async (url: string, requested: number): Promise<void> => {
    const startMark = `${LOAD_MEASURE}-start-${url}`
    performance.mark(startMark)
    const gltf = await loader.loadAsync(url)
    const vrm: unknown = gltf.userData.vrm
    if (!isVrm(vrm)) throw new Error('読み込んだファイルを VRM として読めません。VRM のファイルを選び直してください')
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.rotateVRM0(vrm)
    // 体の一部が画面の端にかかったときに、骨の位置の判定で消えないようにする
    vrm.scene.traverse((object) => {
      object.frustumCulled = false
    })
    performance.measure(LOAD_MEASURE, startMark)

    // 読み込んでいるあいだに別の URL が求められていたら、このモデルは使わずに捨てる
    if (requested !== generation) {
      VRMUtils.deepDispose(vrm.scene)
      return
    }
    if (loaded !== null) {
      scene.remove(loaded.vrm.scene)
      VRMUtils.deepDispose(loaded.vrm.scene)
    }
    scene.add(vrm.scene)
    const bounds = new Box3().setFromObject(vrm.scene)
    loaded = { url, vrm, height: bounds.getSize(new Vector3()).y, axisSign: vrm.meta.metaVersion === '0' ? -1 : 1 }
    size = { width: 0, height: 0, ratio: 0 }
    lastSpringMs = null
  }

  const render: VrmRenderer['render'] = (width, height, frame, nowMs) => {
    const ratio = window.devicePixelRatio
    if (loaded !== null && (size.width !== width || size.height !== height || size.ratio !== ratio)) {
      renderer.setPixelRatio(ratio)
      renderer.setSize(width, height, false)
      // 背の高さが箱の高さの MODEL_SHARE を占め、足もとが下端から FOOT_MARGIN 上に来るようにカメラを引く
      const viewHeight = loaded.height / MODEL_SHARE
      const distance = viewHeight / 2 / Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180)
      const lookY = viewHeight / 2 - viewHeight * FOOT_MARGIN
      camera.aspect = width / height
      camera.position.set(0, lookY, distance)
      camera.lookAt(0, lookY, 0)
      camera.updateProjectionMatrix()
      size = { width, height, ratio }
    }
    if (loaded === null) {
      renderer.render(scene, camera)
      return
    }

    const { humanoid, expressionManager } = loaded.vrm
    for (const bone of VRM_BONES) {
      const node = humanoid.getNormalizedBoneNode(bone)
      // モデルによっては持たない骨（胸・首など）があるので、無ければ飛ばす
      if (node === null) continue
      const rotation = frame.bones[bone]
      node.rotation.set(loaded.axisSign * rotation.x, rotation.y, loaded.axisSign * rotation.z)
    }
    humanoid.update()
    if (expressionManager !== undefined) {
      expressionManager.setValue(HAPPY_EXPRESSION, frame.happy)
      expressionManager.setValue(BLINK_EXPRESSION, frame.blink)
      expressionManager.setValue(MOUTH_EXPRESSION, frame.mouth)
      expressionManager.update()
    }
    // 揺れ物は骨を写したあとに進める（体の動きに引っぱられて揺れるように）
    if (spring && loaded.vrm.springBoneManager !== undefined) {
      loaded.vrm.springBoneManager.update(springStepSeconds(lastSpringMs, nowMs))
      lastSpringMs = nowMs
    }
    renderer.render(scene, camera)
  }

  return { load, render }
}

/** glTF の読み込み結果に VRM が入っていたか（VRMLoaderPlugin が userData.vrm に入れる） */
const isVrm = (value: unknown): value is VRM => typeof value === 'object' && value !== null && 'humanoid' in value && 'scene' in value
