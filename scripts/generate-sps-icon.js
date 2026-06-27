// One-off: add a flat "long shadow" to the existing SPS S logo (keeps the exact letterform).
// Reads the 1024 master, builds a 45° shadow from the white-S silhouette, composites it UNDER the S.
// Run: node scripts/generate-sps-icon.js   (requires `npm i sharp --no-save`)
import sharp from "sharp";

const DARK = process.argv.includes("--dark");
const SRC = process.env.ICON_SRC || "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png";
const NAME = process.env.NAME || (DARK ? "dark" : "light");
const OUT_MASTER  = `/tmp/sps-icon-${NAME}-master.png`;
const OUT_PREVIEW = `/tmp/sps-icon-${NAME}-preview.png`;

// Every color is overridable via env ("r,g,b") so we can render many variants without editing this file.
const rgb = (s, d) => { if (!s) return d; const p = String(s).split(",").map(Number); return (p.length === 3 && p.every(n => !isNaN(n))) ? p : d; };
const S_SCALE = Number(process.env.S_SCALE || 1.09);            // S size within the tile (1.0 = original)
const SHADOW_LEN_FRAC = Number(process.env.SHADOW_LEN || 0.55); // shadow length / icon size
// Light default = dark-red shadow on the crimson tile. Dark default = a crimson trail on a charcoal tile.
const BG_OVERRIDE = rgb(process.env.BG, DARK ? [22, 22, 25] : null);            // null = sample source tile
const SH_NEAR = rgb(process.env.SH_NEAR, DARK ? [184, 29, 36] : [82, 6, 14]);   // trail color at the glyph
const SH_FAR  = rgb(process.env.SH_FAR,  DARK ? [80, 12, 18]  : [126, 12, 24]); // trail color at the corner
const S_COLOR = rgb(process.env.S_COLOR, [255, 255, 255]);     // the letter color

(async () => {
  // Enlarge the S: scale the whole 1024 tile up by S_SCALE, then center-crop back to 1024 (the crimson
  // bg is uniform, so cropping just makes the S bigger). Then read raw pixels of the result.
  const meta = await sharp(SRC).metadata();
  const base = meta.width || 1024;
  const up = Math.round(base * S_SCALE);
  let scaled;
  if (up >= base) {
    const off = Math.round((up - base) / 2);
    scaled = await sharp(SRC).resize(up, up).extract({ left: off, top: off, width: base, height: base }).png().toBuffer();
  } else {
    // Shrinking the S (more padding, e.g. for a small favicon): scale down, then pad back to `base`
    // with the tile color so there's just extra breathing room around a smaller S.
    const c = await sharp(SRC).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    const tile = BG_OVERRIDE || [c[0], c[1], c[2]];
    const p0 = Math.round((base - up) / 2), p1 = base - up - p0;
    scaled = await sharp(SRC).resize(up, up)
      .extend({ top: p0, bottom: p1, left: p0, right: p1, background: { r: tile[0], g: tile[1], b: tile[2], alpha: 1 } })
      .png().toBuffer();
  }
  const { data, info } = await sharp(scaled).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const bg = BG_OVERRIDE || [data[0], data[1], data[2]];  // dark variant overrides; else sample the tile color
  const N = Math.round(W * SHADOW_LEN_FRAC);

  // Per-pixel "whiteness" (the S is white; crimson bg has low G/B) → smooth alpha that keeps the AA edge.
  const whiteA = new Float32Array(W * H);
  const isS = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const g = data[i * C + 1], b = data[i * C + 2], a = data[i * C + 3];
    let wa = a > 8 ? (Math.min(g, b) - 45) / (205 - 45) : 0;
    wa = wa < 0 ? 0 : wa > 1 ? 1 : wa;
    whiteA[i] = wa;
    isS[i] = wa > 0.5 ? 1 : 0;
  }

  // Long-shadow mask via a single diagonal pass: a pixel is in shadow if walking up-left along the
  // 45° diagonal hits the S within N steps (steps = remaining shadow length).
  const steps = new Int16Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (isS[idx]) steps[idx] = N;
      else if (x > 0 && y > 0 && steps[(y - 1) * W + (x - 1)] > 0) steps[idx] = steps[(y - 1) * W + (x - 1)] - 1;
      else steps[idx] = 0;
    }
  }

  // Compose: crimson bg → faded shadow → white S (alpha-blended so the letterform edge stays clean).
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    let base = bg;
    if (!isS[i] && steps[i] > 0) {
      const t = 1 - steps[i] / N;                          // 0 at the glyph → 1 at the far tip
      base = [
        Math.round(SH_NEAR[0] + (SH_FAR[0] - SH_NEAR[0]) * t),
        Math.round(SH_NEAR[1] + (SH_FAR[1] - SH_NEAR[1]) * t),
        Math.round(SH_NEAR[2] + (SH_FAR[2] - SH_NEAR[2]) * t),
      ];
    }
    const wa = whiteA[i];
    out[i * 4]     = Math.round(base[0] * (1 - wa) + S_COLOR[0] * wa);
    out[i * 4 + 1] = Math.round(base[1] * (1 - wa) + S_COLOR[1] * wa);
    out[i * 4 + 2] = Math.round(base[2] * (1 - wa) + S_COLOR[2] * wa);
    out[i * 4 + 3] = 255;
  }

  await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toFile(OUT_MASTER);

  // Rounded preview (iOS squircle radius ~22.35%) so it reads like a real home-screen icon.
  const PV = 600, r = Math.round(PV * 0.2235);
  const mask = Buffer.from(`<svg width="${PV}" height="${PV}"><rect width="${PV}" height="${PV}" rx="${r}" ry="${r}"/></svg>`);
  await sharp(OUT_MASTER).resize(PV, PV).composite([{ input: mask, blend: "dest-in" }]).png().toFile(OUT_PREVIEW);

  console.log("wrote", OUT_MASTER, "and", OUT_PREVIEW, `(${W}x${H}, bg=${bg}, shadowLen=${N})`);

  // --write: stamp the new icon into every tracked source/asset slot (square, full-bleed — the boot
  // splash + iOS app icon apply their own rounding). dist/ is rebuilt by Vercel; ios/public by cap copy.
  if (process.argv.includes("--write")) {
    const targets = [
      ["ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png", 1024],
      ["icon-512.png", 512],
      ["ios/App/App/Assets.xcassets/SplashLogo.imageset/icon-512.png", 512],
      ["icon-192.png", 192],
      ["icon-180.png", 180],
      ["favicon.png", 48],
    ];
    for (const [p, sz] of targets) { await sharp(OUT_MASTER).resize(sz, sz).png().toFile(p); console.log("wrote", p, sz); }
    // A clean copy to hand off for the marketing website's favicon.
    await sharp(OUT_MASTER).resize(512, 512).png().toFile("/tmp/sps-favicon-512.png");
    console.log("wrote /tmp/sps-favicon-512.png (website favicon hand-off)");
  }
})().catch(e => { console.error(e); process.exit(1); });
