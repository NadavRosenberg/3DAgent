import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const KTX2_TRANSCODER =
  "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/";

// Loads a GLB avatar and exposes controls for blinking, idle motion and
// lip-sync. Supports three rig types automatically detected on load:
//   "arkit"  — ARKit blendshape face (jawOpen, mouthFunnel, …)
//   "viseme" — Ready Player Me Oculus viseme blendshapes
//   "mixamo" — Full-body Mixamo skeleton (bone-based jaw simulation)
//   "none"   — Unknown, no animation applied

const VISEME_KEYS = [
  "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD",
  "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR",
  "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
];

// Reusable temporaries — avoid allocating in the hot update path.
const _q  = new THREE.Quaternion();
const _e  = new THREE.Euler();
const _v3 = new THREE.Vector3();

export class Avatar {
  constructor(renderer) {
    this.renderer = renderer;
    this.root     = new THREE.Group();
    this.meshes   = [];     // meshes with morph targets
    this.dict     = {};     // morphName → [{ mesh, index }]
    this.kind     = "none"; // "arkit" | "viseme" | "mixamo" | "none"
    this.head     = null;   // main head/neck bone or Object3D

    // Mixamo bone references (null for non-Mixamo avatars)
    this._hips         = null;
    this._spine        = null;
    this._spine1       = null;
    this._spine2       = null;
    this._neck         = null;
    this._leftShoulder = null;
    this._rightShoulder= null;
    this._leftArm      = null;
    this._rightArm     = null;
    this._leftForeArm  = null;
    this._rightForeArm = null;
    this._boneRest     = new Map(); // bone.name → rest Quaternion

    this._blink     = 0;
    this._nextBlink = 1.5;
    this._t         = 0;
    this._target    = {};  // smoothed morph influence targets
    this._mouthOpen  = 0;
    this._mouthShape = 0.5;
    this._viseme     = null;
  }

  async load(url) {
    this.root.clear();
    this.meshes   = [];
    this.dict     = {};
    this.kind     = "none";
    this.head     = null;
    this._boneRest.clear();
    this._hips = this._spine = this._spine1 = this._spine2 = null;
    this._neck = this._leftShoulder = this._rightShoulder = null;
    this._leftArm = this._rightArm = null;
    this._leftForeArm = this._rightForeArm = null;

    const loader = new GLTFLoader();
    if (this.renderer) {
      const ktx2 = new KTX2Loader()
        .setTranscoderPath(KTX2_TRANSCODER)
        .detectSupport(this.renderer);
      loader.setKTX2Loader(ktx2);
    }
    loader.setMeshoptDecoder(MeshoptDecoder);

    const gltf  = await loader.loadAsync(url);
    const model = gltf.scene;

    // ── Pass 1: meshes ────────────────────────────────────────────────────────
    model.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        this._applyHologramLook(o.material);
        if (o.morphTargetDictionary) {
          this.meshes.push(o);
          for (const [name, idx] of Object.entries(o.morphTargetDictionary)) {
            (this.dict[name] ||= []).push({ mesh: o, index: idx });
          }
        }
      }
    });

    // ── Pass 2: bones ─────────────────────────────────────────────────────────
    model.traverse((o) => {
      if (!o.isBone && !o.name?.startsWith("mixamorig:")) return;
      this._boneRest.set(o.name, o.quaternion.clone());
      switch (o.name) {
        case "mixamorig:Head":          this.head          = o; break;
        case "mixamorig:Hips":          this._hips         = o; break;
        case "mixamorig:Spine":         this._spine        = o; break;
        case "mixamorig:Spine1":        this._spine1       = o; break;
        case "mixamorig:Spine2":        this._spine2       = o; break;
        case "mixamorig:Neck":          this._neck         = o; break;
        case "mixamorig:LeftShoulder":  this._leftShoulder = o; break;
        case "mixamorig:RightShoulder": this._rightShoulder= o; break;
        case "mixamorig:LeftArm":       this._leftArm      = o; break;
        case "mixamorig:RightArm":      this._rightArm     = o; break;
        case "mixamorig:LeftForeArm":   this._leftForeArm  = o; break;
        case "mixamorig:RightForeArm":  this._rightForeArm = o; break;
      }
    });

    // Fallback head detection for non-Mixamo models.
    if (!this.head) {
      model.traverse((o) => {
        const n = (o.name || "").toLowerCase();
        if (!this.head && (n.includes("head") || n.includes("neck"))) this.head = o;
      });
    }

    // ── Detect rig kind ───────────────────────────────────────────────────────
    if (this.has("jawOpen"))                              this.kind = "arkit";
    else if (VISEME_KEYS.some((v) => this.has(v)))        this.kind = "viseme";
    else if (this._hips?.name?.startsWith("mixamorig:")) this.kind = "mixamo";

    // Zero all morph targets so we start from a neutral expression.
    for (const mesh of this.meshes) mesh.morphTargetInfluences.fill(0);

    this._frame(model);
    this.root.add(model);
    return this;
  }

  has(name) { return !!this.dict[name]; }

  // Scale model to ~1.8 units tall, feet at y=0.
  _frame(model) {
    const box    = new THREE.Box3().setFromObject(model);
    const size   = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const scale = 1.8 / (size.y || 1);
    model.scale.setScalar(scale);

    box.setFromObject(model);
    box.getCenter(center);
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y - 0.02; // feet just above origin
  }

  // Returns the camera focus point and a radius that tells the caller how far
  // to pull back. Also signals whether this is a full-body model.
  getFocus() {
    this.root.updateMatrixWorld(true);

    if (this.kind === "mixamo") {
      // For a full-body Mixamo avatar signal the caller to use a fixed wide-angle
      // view instead of computing a tight focus — avoids the arms-in-T-pose
      // inflating the bounding box and pushing the camera too far.
      const box    = new THREE.Box3().setFromObject(this.root);
      const size   = box.getSize(new THREE.Vector3());
      const height = size.y || 1.8;
      // Aim at the mid-body (waist level).
      const centerY = (box.min.y + box.max.y) * 0.5;
      return {
        center:   new THREE.Vector3(0, centerY, 0),
        radius:   height * 0.50,
        fullBody: true,
      };
    }

    // Face-scan / viseme avatar: focus on the face mesh bounding box.
    const faceMeshes = this.meshes.filter((m) => {
      const d = m.morphTargetDictionary || {};
      return d.jawOpen !== undefined ||
        Object.keys(d).some((k) => k.startsWith("viseme"));
    });
    const list = faceMeshes.length ? faceMeshes : this.meshes;
    const box  = new THREE.Box3();
    if (list.length) list.forEach((m) => box.expandByObject(m));
    else box.setFromObject(this.root);

    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    return { center, radius: Math.max(size.x, size.y) * 0.5, fullBody: false };
  }

  // ── Hologram shader ────────────────────────────────────────────────────────
  // Keeps the mesh fully opaque (no see-through skin revealing inner geometry),
  // then adds a cyan tint, scanline grid and rim glow purely via RGB.
  _applyHologramLook(material) {
    const mats = Array.isArray(material) ? material : [material];
    for (const m of mats) {
      if (!m || m.userData.holo) continue;
      m.userData.holo = true;
      // Stay opaque so inner geometry (teeth, jaw mesh) doesn't bleed through.
      m.transparent = false;
      m.depthWrite  = true;
      if (m.emissive) m.emissive = new THREE.Color(0x071a24);

      m.onBeforeCompile = (shader) => {
        shader.uniforms.uRim = { value: new THREE.Color(0x5fe3ff) };
        shader.vertexShader =
          "varying vec3 vViewN;\nvarying vec3 vViewPos;\n" +
          shader.vertexShader.replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
             vViewN   = normalize(normalMatrix * objectNormal);
             vViewPos = (modelViewMatrix * vec4(transformed,1.0)).xyz;`
          );
        shader.fragmentShader =
          "uniform vec3 uRim;\nvarying vec3 vViewN;\nvarying vec3 vViewPos;\n" +
          shader.fragmentShader.replace(
            "#include <dithering_fragment>",
            `#include <dithering_fragment>
             float fres = pow(1.0 - abs(dot(normalize(vViewN), normalize(-vViewPos))), 2.5);
             // Cyan hologram tint — blends with the original texture colour.
             gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.28, 0.82, 1.0), 0.38);
             // Subtle horizontal scanlines.
             float scan = mod(gl_FragCoord.y * 0.45, 1.0);
             gl_FragColor.rgb *= (0.94 + 0.06 * step(0.5, scan));
             // Rim glow adds brightness at silhouette edges — purely additive.
             gl_FragColor.rgb += uRim * fres * 0.80;`
          );
      };
      m.needsUpdate = true;
    }
  }

  // ── Morph helpers ─────────────────────────────────────────────────────────

  _set(name, value) {
    const targets = this.dict[name];
    if (!targets) return;
    for (const { mesh, index } of targets) mesh.morphTargetInfluences[index] = value;
  }

  _ease(name, value, speed, dt) {
    if (!this.has(name)) return;
    const cur  = this._target[name] ?? 0;
    const next = cur + (value - cur) * Math.min(1, speed * dt);
    this._target[name] = next;
    this._set(name, next);
  }

  // ── Mouth API ─────────────────────────────────────────────────────────────

  setViseme(v) { this._viseme = v; }

  setMouth(open, shape = 0.5) {
    this._mouthOpen  = open;
    this._mouthShape = shape;
    this._viseme     = null;
  }

  resetMouth() {
    this._mouthOpen  = 0;
    this._mouthShape = 0.5;
    this._viseme     = null;
  }

  // ── Bone helper: rotate a bone relative to its rest quaternion ────────────
  _rotateBone(bone, key, ex, ey, ez) {
    if (!bone) return;
    const rest = this._boneRest.get(key);
    if (!rest) { bone.rotation.set(ex, ey, ez); return; }
    _e.set(ex, ey, ez);
    _q.setFromEuler(_e);
    bone.quaternion.copy(rest).multiply(_q);
  }

  // ── Main update ───────────────────────────────────────────────────────────
  update(dt) {
    this._t += dt;
    const t = this._t;

    if (this.kind === "mixamo") {
      this._updateMixamo(t, dt);
      return;
    }

    // ARKit / viseme / none — original behaviour.
    if (this.head) {
      this.head.rotation.y = Math.sin(t * 0.5) * 0.06;
      this.head.rotation.x = Math.sin(t * 0.37) * 0.03;
    }
    this.root.position.y = Math.sin(t * 0.8) * 0.01;
    this.root.rotation.y = Math.sin(t * 0.2) * 0.04;

    // Blinking.
    this._nextBlink -= dt;
    if (this._nextBlink <= 0) { this._blink = 1; this._nextBlink = 2 + Math.random() * 4; }
    if (this._blink > 0) {
      this._blink = Math.max(0, this._blink - dt * 9);
      const b = Math.sin((1 - this._blink) * Math.PI);
      this._set("eyeBlink_L", b); this._set("eyeBlink_R", b); this._set("eyesClosed", b);
    } else {
      this._set("eyeBlink_L", 0); this._set("eyeBlink_R", 0); this._set("eyesClosed", 0);
      this._set("eyeSquint_L", 0); this._set("eyeSquint_R", 0);
      this._set("eyeLookDown_L", 0); this._set("eyeLookDown_R", 0);
    }

    // Mouth / lip-sync.
    if (this.kind === "arkit") {
      const v = this._viseme;
      if (v) {
        this._ease("jawOpen",          v.open  * 0.88,  20, dt);
        this._ease("mouthFunnel",      v.round * 0.65,  20, dt);
        this._ease("mouthPucker",      v.round * 0.42,  20, dt);
        this._ease("mouthSmile_L",     v.smile * 0.42,  18, dt);
        this._ease("mouthSmile_R",     v.smile * 0.42,  18, dt);
        this._ease("mouthPress_L",     v.close * 0.90,  28, dt);
        this._ease("mouthPress_R",     v.close * 0.90,  28, dt);
        this._ease("mouthClose",       v.close * 0.50,  28, dt);
        this._ease("mouthUpperUp_L",   v.bite  * 0.50,  22, dt);
        this._ease("mouthUpperUp_R",   v.bite  * 0.50,  22, dt);
        this._ease("mouthLowerDown_L", v.open  * 0.50,  18, dt);
        this._ease("mouthLowerDown_R", v.open  * 0.50,  18, dt);
        this._ease("jawForward",       v.fwd   * 0.35,  18, dt);
        this._ease("tongueOut",        v.tongue * 0.45, 22, dt);
      } else {
        const open  = this._mouthOpen || 0;
        const shape = this._mouthShape ?? 0.5;
        this._ease("jawOpen",          open * 0.88,              22, dt);
        this._ease("mouthFunnel",      open * (1-shape) * 0.50,  22, dt);
        this._ease("mouthPucker",      open * (1-shape) * 0.30,  22, dt);
        this._ease("mouthSmile_L",     open * shape    * 0.28,   18, dt);
        this._ease("mouthSmile_R",     open * shape    * 0.28,   18, dt);
        this._ease("mouthPress_L",     0, 22, dt);
        this._ease("mouthPress_R",     0, 22, dt);
        this._ease("mouthClose",       0, 22, dt);
        this._ease("mouthUpperUp_L",   0, 22, dt);
        this._ease("mouthUpperUp_R",   0, 22, dt);
        this._ease("mouthLowerDown_L", open * 0.40, 18, dt);
        this._ease("mouthLowerDown_R", open * 0.40, 18, dt);
        this._ease("jawForward",       0, 18, dt);
        this._ease("tongueOut",        0, 18, dt);
      }
    } else if (this.kind === "viseme") {
      const v    = this._viseme;
      const open  = v ? v.open  : (this._mouthOpen || 0);
      const shape = v ? v.smile : (this._mouthShape ?? 0.5);
      this._ease("viseme_aa", open * Math.max(0, shape - 0.2), 22, dt);
      this._ease("viseme_O",  open * (1 - shape) * 0.8,        22, dt);
      this._ease("viseme_E",  open * shape * 0.5,               22, dt);
      this._ease("viseme_U",  v ? v.round * 0.8 : 0,           22, dt);
      this._ease("viseme_PP", v ? v.close * 0.9 : 0,           28, dt);
    }
  }

  // ── Mixamo full-body idle + bone-based jaw simulation ────────────────────
  _updateMixamo(t, dt) {
    const breathe = Math.sin(t * 1.15);         // breathing cycle
    const sway    = Math.sin(t * 0.40);         // slow sway
    const slow    = Math.sin(t * 0.20);         // very slow drift

    // ── Spine breathing ───────────────────────────────────────────────────
    // Spine2 (upper chest): subtle forward flex on inhale.
    this._rotateBone(this._spine2, "mixamorig:Spine2",
      breathe * 0.022,           // x — chest rises
      sway    * 0.010,           // y — slight twist
      slow    * 0.008);          // z — lean

    // Spine1 (mid chest): complementary counter-curve.
    this._rotateBone(this._spine1, "mixamorig:Spine1",
      breathe * 0.014,
      0, 0);

    // Spine (lower): very subtle.
    this._rotateBone(this._spine, "mixamorig:Spine",
      breathe * 0.008,
      sway * 0.005,
      0);

    // ── Hips weight shift ────────────────────────────────────────────────
    this._rotateBone(this._hips, "mixamorig:Hips",
      0,
      slow * 0.018,              // y — face slightly left/right
      sway * 0.012);             // z — slight hip tilt

    // ── Shoulder breathing raise ─────────────────────────────────────────
    this._rotateBone(this._leftShoulder,  "mixamorig:LeftShoulder",
      0, 0, breathe * 0.018);
    this._rotateBone(this._rightShoulder, "mixamorig:RightShoulder",
      0, 0, -breathe * 0.018);

    // ── Arm gentle pendulum ───────────────────────────────────────────────
    const armSwing = Math.sin(t * 0.55) * 0.035;
    this._rotateBone(this._leftArm,  "mixamorig:LeftArm",
      armSwing, 0, 0);
    this._rotateBone(this._rightArm, "mixamorig:RightArm",
      -armSwing, 0, 0);

    // Forearms: complement arm swing.
    const foreSwing = Math.sin(t * 0.55 + 0.3) * 0.02;
    this._rotateBone(this._leftForeArm,  "mixamorig:LeftForeArm",
      foreSwing, 0, 0);
    this._rotateBone(this._rightForeArm, "mixamorig:RightForeArm",
      -foreSwing, 0, 0);

    // ── Head look-around + jaw simulation ────────────────────────────────
    const v       = this._viseme;
    const open    = v ? v.open : (this._mouthOpen || 0);

    // Current smoothed jaw opening (ease toward target).
    const jawTarget = open * 0.09;
    this._jawCur  = (this._jawCur ?? 0) + (jawTarget - (this._jawCur ?? 0)) * Math.min(1, 18 * dt);

    this._rotateBone(this.head, "mixamorig:Head",
      this._jawCur + Math.sin(t * 0.38) * 0.025,   // x — jaw + nod
      Math.sin(t * 0.52) * 0.07,                    // y — look left/right
      Math.sin(t * 0.28) * 0.015);                  // z — slight tilt

    // Neck mirrors head slightly (distributes rotation naturally).
    this._rotateBone(this._neck, "mixamorig:Neck",
      Math.sin(t * 0.38) * 0.010,
      Math.sin(t * 0.52) * 0.025,
      0);

    // ── Whole-body gentle rotation ────────────────────────────────────────
    this.root.rotation.y = slow * 0.025;
    // Keep feet planted (no vertical float for full-body).
  }
}
