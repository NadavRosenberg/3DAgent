// Lightweight English grapheme-to-phoneme + phoneme-to-viseme engine.
//
// Instead of mapping audio amplitude → jaw open (which looks the same for
// every sound), this converts the text we're about to speak into a timed
// sequence of mouth shapes BEFORE speaking, then plays the schedule back
// frame-by-frame while the audio analyser adds the energy envelope.
//
// Result: correct vowel/consonant mouth shapes × natural amplitude variation.

// ─── 15 Oculus-style viseme categories ─────────────────────────────────────
// Each maps to a distinct recognisable mouth shape.
//
//   sil  – silence / between words
//   pp   – bilabials   p b m       (lips fully pressed together)
//   ff   – labiodental f v         (upper teeth on lower lip)
//   th   – dental      θ ð         (tongue tip visible)
//   dd   – alveolar    t d l       (neutral open)
//   kk   – velar       k g h       (back of mouth, neutral lips)
//   ch   – postalveolar ch sh zh j (lips slightly funnel)
//   ss   – sibilant    s z         (lips slightly spread, teeth close)
//   nn   – nasal       n ŋ         (nearly closed, neutral)
//   rr   – rhotic      r           (lips slightly rounded/puckered)
//   aa   – open vowel  "ah"        (jaw very open, lips neutral)
//   ae   – open-mid    "eh" "a"    (jaw medium, corners spread)
//   ih   – close front "ee" "i"    (jaw small, wide smile)
//   oh   – open-mid back "oh"      (jaw medium-large, slight round)
//   oo   – close back  "oo" "u"    (jaw nearly closed, very rounded)

// Mouth shape per viseme.
//   open:  0..1  jaw / mouth opening
//   round: 0..1  lip funnel/pucker (mouthFunnel + mouthPucker)
//   smile: 0..1  lip corners pulled back (mouthSmile)
//   close: 0..1  lip press / closure (pp, mm)
//   bite:  0..1  upper-lip raised (ff, vv)
//   fwd:   0..1  jaw forward (rr)
//   tongue:0..1  tongue visible (th)
const SHAPES = {
  sil: { open:0.00, round:0.00, smile:0.00, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  pp:  { open:0.00, round:0.00, smile:0.00, close:0.95, bite:0.00, fwd:0.00, tongue:0.00 },
  ff:  { open:0.08, round:0.00, smile:0.10, close:0.00, bite:0.65, fwd:0.00, tongue:0.00 },
  th:  { open:0.20, round:0.00, smile:0.05, close:0.00, bite:0.00, fwd:0.05, tongue:0.40 },
  dd:  { open:0.14, round:0.00, smile:0.08, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  kk:  { open:0.26, round:0.00, smile:0.00, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  ch:  { open:0.10, round:0.40, smile:0.00, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  ss:  { open:0.06, round:0.00, smile:0.45, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  nn:  { open:0.10, round:0.00, smile:0.00, close:0.12, bite:0.00, fwd:0.00, tongue:0.00 },
  rr:  { open:0.22, round:0.45, smile:0.00, close:0.00, bite:0.00, fwd:0.20, tongue:0.00 },
  aa:  { open:0.88, round:0.00, smile:0.08, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  ae:  { open:0.55, round:0.00, smile:0.55, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  ih:  { open:0.24, round:0.00, smile:0.85, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  oh:  { open:0.68, round:0.28, smile:0.00, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
  oo:  { open:0.10, round:0.88, smile:0.00, close:0.00, bite:0.00, fwd:0.00, tongue:0.00 },
};

// Relative duration weight per viseme (normalised so average ≈ 1.0).
// Vowels are held longer; stops are short transients.
const DUR = {
  sil:1.6, pp:0.6, ff:1.0, th:1.0, dd:0.65, kk:0.65,
  ch:0.9, ss:1.1, nn:0.85, rr:0.90,
  aa:1.5, ae:1.25, ih:1.15, oh:1.35, oo:1.20,
};

// ─── Grapheme-to-viseme rules (longest match first) ─────────────────────────
// Each entry: [grapheme_pattern, viseme_id]
const RULES = [
  // 3-char clusters
  ['igh','ih'],['tch','ch'],['dge','dd'],['sch','ch'],
  // 2-char vowel digraphs
  ['oo','oo'],['ou','oh'],['ow','oh'],['aw','oh'],['au','oh'],
  ['ai','ae'],['ay','ae'],['ei','ae'],['ey','ae'],
  ['ea','ih'],['ee','ih'],['ie','ih'],
  ['oi','oh'],['oy','oh'],['ue','oo'],['ui','oo'],
  // 2-char consonant clusters
  ['ng','nn'],['nk','kk'],['ch','ch'],['sh','ch'],['zh','ch'],
  ['ph','ff'],['wh','ff'],['ck','kk'],['qu','kk'],['gh','kk'],
  ['th','th'],
  // Single vowels
  ['a','aa'],['e','ae'],['i','ih'],['o','oh'],['u','oo'],['y','ih'],
  // Single consonants
  ['p','pp'],['b','pp'],['m','pp'],
  ['f','ff'],['v','ff'],
  ['t','dd'],['d','dd'],['l','dd'],
  ['n','nn'],
  ['k','kk'],['c','kk'],['g','kk'],['q','kk'],['h','kk'],['x','kk'],
  ['s','ss'],['z','ss'],
  ['r','rr'],
  ['j','ch'],
  ['w','oo'],
];

function wordToVisemes(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  const out = [];
  let i = 0;
  while (i < w.length) {
    let matched = false;
    for (const [pat, vis] of RULES) {
      if (w.startsWith(pat, i)) {
        // Deduplicate consecutive identical visemes (e.g. "ll" → one 'dd')
        if (out[out.length - 1] !== vis) out.push(vis);
        i += pat.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return out.length ? out : ['sil'];
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Returns a shape object for interpolation.
export function shape(vis) { return SHAPES[vis] || SHAPES.sil; }

// Returns the viseme list for each word (for word-boundary re-sync).
export function wordsToVisemes(text) {
  return text.trim().split(/\s+/).filter(Boolean).map(wordToVisemes);
}

// Builds a timed keyframe array: [{tMs, vis}, …]
// tMs values are absolute milliseconds from the start of speech.
// If totalDurationMs is unknown, pass 0 and use AVG_MS per phoneme.
export function schedule(text, totalDurationMs) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  // Flatten into phoneme list with relative duration weights.
  const phonemes = [];
  for (let wi = 0; wi < words.length; wi++) {
    const visemes = wordToVisemes(words[wi]);
    for (const vis of visemes) phonemes.push({ vis, dur: DUR[vis] || 1.0 });
    if (wi < words.length - 1) phonemes.push({ vis: 'sil', dur: DUR.sil * 0.4 });
  }

  const totalWeight = phonemes.reduce((s, p) => s + p.dur, 0);
  const AVG_MS = 75;
  const msPerUnit = totalDurationMs > 0
    ? totalDurationMs / totalWeight
    : AVG_MS;

  const frames = [];
  let t = 0;
  for (const p of phonemes) {
    frames.push({ tMs: t, vis: p.vis });
    t += p.dur * msPerUnit;
  }
  return frames;
}
