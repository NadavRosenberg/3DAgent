import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const KTX2_TRANSCODER =
  "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/";

// Loads a GLB avatar, discovers its facial morph targets (works with both
// ARKit blendshapes like `jawOpen` and Ready Player Me "Oculus" visemes like
// `viseme_aa`), and exposes simple controls for blinking, idle motion and
// driving the mouth for lip-sync.

const VISEME_KEYS = [
  "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD",
  "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR",
  "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
];

export class Avatar {
  constructor(renderer) {
    this.renderer = renderer;
    this.root = new THREE.Group();
    this.meshes = [];          // meshes that own morph targets
    this.dict = {};            // morphName -> [{mesh, index}]
    this.kind = "none";        // "arkit" | "viseme" | "none"
    this.head = null;          // node we gently rotate for "alive" feel
    this._blink = 0;
    this._nextBlink = 1.5;
    this._t = 0;
    this._target = {};         // smoothed morph influence targets
  }

  async load(url) {
    // Reset any previous avatar.
    this.root.clear();
    this.meshes = [];
    this.dict = {};
    this.kind = "none";
    this.head = null;

    const loader = new GLTFLoader();
    // Support GLBs that use KTX2-compressed textures and/or meshopt
    // compression (the bundled avatar and many Ready Player Me exports do).
    if (this.renderer) {
      const ktx2 = new KTX2Loader()
        .setTranscoderPath(KTX2_TRANSCODER)
        .detectSupport(this.renderer);
      loader.setKTX2Loader(ktx2);
    }
    loader.setMeshoptDecoder(MeshoptDecoder);

    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;

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
      const n = (o.name || "").toLowerCase();
      if (!this.head && (n.includes("head") || n.includes("neck"))) this.head = o;
    });

    if (this.has("jawOpen")) this.kind = "arkit";
    else if (VISEME_KEYS.some((v) => this.has(v))) this.kind = "viseme";

    this._frame(model);
    this.root.add(model);
    return this;
  }

  has(name) { return !!this.dict[name]; }

  // Normalize the model: ~1.6 units tall, centered horizontally, sitting just
  // above the projector base (y = 0).
  _frame(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const scale = 1.6 / (size.y || 1);
    model.scale.setScalar(scale);

    box.setFromObject(model);
    box.getCenter(center);
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y - 0.05;   // feet/chin floats above the base
  }

  // Returns where the camera should look (the face) and how big it is, so the
  // caller can frame the head whether this is a head-scan or a full body.
  getFocus() {
    this.root.updateMatrixWorld(true);
    const faceMeshes = this.meshes.filter((m) => {
      const d = m.morphTargetDictionary || {};
      return d.jawOpen !== undefined ||
        Object.keys(d).some((k) => k.startsWith("viseme"));
    });
    const list = faceMeshes.length ? faceMeshes : this.meshes;
    const box = new THREE.Box3();
    if (list.length) list.forEach((m) => box.expandByObject(m));
    else box.setFromObject(this.root);

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    return { center, radius: Math.max(size.x, size.y) * 0.5 };
  }

  // Give every material a cyan hologram rim glow + slight transparency.
  _applyHologramLook(material) {
    const mats = Array.isArray(material) ? material : [material];
    for (const m of mats) {
      if (!m || m.userData.holo) continue;
      m.userData.holo = true;
      m.transparent = true;
      m.opacity = 0.95;
      if (m.emissive) m.emissive = new THREE.Color(0x06161e);
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uRim = { value: new THREE.Color(0x5fe3ff) };
        shader.vertexShader =
          "varying vec3 vViewN;\nvarying vec3 vViewPos;\n" +
          shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\n vViewN = normalize(normalMatrix * objectNormal);\n vViewPos = (modelViewMatrix * vec4(transformed,1.0)).xyz;"
          );
        shader.fragmentShader =
          "uniform vec3 uRim;\nvarying vec3 vViewN;\nvarying vec3 vViewPos;\n" +
          shader.fragmentShader.replace(
            "#include <dithering_fragment>",
            "#include <dithering_fragment>\n float fres = pow(1.0 - abs(dot(normalize(vViewN), normalize(-vViewPos))), 3.0);\n gl_FragColor.rgb += uRim * fres * 0.6;\n gl_FragColor.a = max(gl_FragColor.a, fres * 0.8);"
          );
      };
      m.needsUpdate = true;
    }
  }

  _set(name, value) {
    const targets = this.dict[name];
    if (!targets) return;
    for (const { mesh, index } of targets) mesh.morphTargetInfluences[index] = value;
  }

  // Smoothly approach a morph value each frame.
  _ease(name, value, speed, dt) {
    if (!this.has(name)) return;
    const cur = this._target[name] ?? 0;
    const next = cur + (value - cur) * Math.min(1, speed * dt);
    this._target[name] = next;
    this._set(name, next);
  }

  // ── Mouth API ──────────────────────────────────────────────────────────────

  // Rich phoneme-based mouth control. Each field is 0..1.
  //   open:   jaw opening
  //   round:  lip funnel / pucker (oo, oh, rr, ch)
  //   smile:  lip corners spread  (ee, ae, ss)
  //   close:  lip press           (pp, bb, mm)
  //   bite:   upper lip up        (ff, vv)
  //   fwd:    jaw forward         (rr)
  //   tongue: tongue tip out      (th)
  setViseme(v) { this._viseme = v; }

  // Legacy simple driver — kept for fallback compatibility.
  setMouth(open, shape = 0.5) {
    this._mouthOpen = open;
    this._mouthShape = shape;
    this._viseme = null;
  }

  resetMouth() {
    this._mouthOpen = 0;
    this._mouthShape = 0.5;
    this._viseme = null;
  }

  // ── Main update ────────────────────────────────────────────────────────────
  update(dt) {
    this._t += dt;

    // Idle "alive" head motion.
    if (this.head) {
      this.head.rotation.y = Math.sin(this._t * 0.5) * 0.06;
      this.head.rotation.x = Math.sin(this._t * 0.37) * 0.03;
    }
    this.root.position.y = Math.sin(this._t * 0.8) * 0.01;
    this.root.rotation.y = Math.sin(this._t * 0.2) * 0.04;

    // Blinking.
    this._nextBlink -= dt;
    if (this._nextBlink <= 0) { this._blink = 1; this._nextBlink = 2 + Math.random() * 4; }
    if (this._blink > 0) {
      this._blink = Math.max(0, this._blink - dt * 9);
      const b = Math.sin((1 - this._blink) * Math.PI);
      this._set("eyeBlink_L", b); this._set("eyeBlink_R", b);
      this._set("eyesClosed", b);
    }

    // Mouth / lip-sync.
    if (this.kind === "arkit") {
      const v = this._viseme;
      if (v) {
        // Phoneme-driven path: each viseme maps to distinct blendshapes.
        // Easing speeds differ: lip-press (stops) snaps fast; vowels glide.
        this._ease("jawOpen",          v.open  * 0.88,  20, dt);
        this._ease("mouthFunnel",      v.round * 0.65,  20, dt);
        this._ease("mouthPucker",      v.round * 0.42,  20, dt);
        this._ease("mouthSmile_L",     v.smile * 0.42,  18, dt);
        this._ease("mouthSmile_R",     v.smile * 0.42,  18, dt);
        this._ease("mouthPress_L",     v.close * 0.90,  28, dt); // fast snap for p/b/m
        this._ease("mouthPress_R",     v.close * 0.90,  28, dt);
        this._ease("mouthClose",       v.close * 0.50,  28, dt);
        this._ease("mouthUpperUp_L",   v.bite  * 0.50,  22, dt);
        this._ease("mouthUpperUp_R",   v.bite  * 0.50,  22, dt);
        this._ease("mouthLowerDown_L", v.open  * 0.50,  18, dt);
        this._ease("mouthLowerDown_R", v.open  * 0.50,  18, dt);
        this._ease("jawForward",       v.fwd   * 0.35,  18, dt);
        this._ease("tongueOut",        v.tongue * 0.45, 22, dt);
      } else {
        // Legacy setMouth() fallback.
        const open = this._mouthOpen || 0;
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
      // Ready Player Me Oculus visemes — drive the corresponding targets.
      const v = this._viseme;
      const open  = v ? v.open  : (this._mouthOpen || 0);
      const shape = v ? v.smile : (this._mouthShape ?? 0.5);
      this._ease("viseme_aa", open * Math.max(0, shape - 0.2), 22, dt);
      this._ease("viseme_O",  open * (1 - shape) * 0.8,        22, dt);
      this._ease("viseme_E",  open * shape * 0.5,               22, dt);
      this._ease("viseme_U",  v ? v.round * 0.8 : 0,           22, dt);
      this._ease("viseme_PP", v ? v.close * 0.9 : 0,           28, dt);
    }
  }
}
