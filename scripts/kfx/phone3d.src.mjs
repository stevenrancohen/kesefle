/*! kfx-phone3d · Kesefle homepage 3D phone (Three.js) · 2026-11-08
 * Source for /js/kfx-phone3d.mjs. Build: scripts/kfx/build-phone3d.sh
 * mount(viewer, canvas, { motion }) returns { setScroll(p), destroy() } or null.
 * Drag to turn it (mouse or a sideways touch drag); vertical touch keeps
 * scrolling the page. Renders only while the viewer is on screen.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Shape, ShapeGeometry, ExtrudeGeometry, PlaneGeometry, CylinderGeometry,
  MeshPhysicalMaterial, MeshStandardMaterial, MeshBasicMaterial, CanvasTexture, SRGBColorSpace,
  PMREMGenerator, DirectionalLight, AmbientLight, ACESFilmicToneMapping
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const W = 1.0, H = 2.05, D = 0.1;
const SCREEN_W = 0.93, SCREEN_H = 1.98;
const FONT_HE = 'Heebo, Rubik, "Segoe UI", Arial, sans-serif';
const FONT_NUM = 'Rubik, Heebo, "Segoe UI", Arial, sans-serif';

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function roundedShape(w, h, r) {
  const s = new Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
// rounded slab centred on z: big corner radius in the plane, soft bevelled edges
function slab(w, h, r, depth, bevel, segs) {
  const inner = Math.max(0.0002, depth - 2 * bevel);
  const g = new ExtrudeGeometry(roundedShape(w - 2 * bevel, h - 2 * bevel, Math.max(0.001, r - bevel)), {
    depth: inner, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: segs || 4, curveSegments: 20
  });
  g.translate(0, 0, -inner / 2);
  return g;
}
function text(ctx, str, x, y, font, color, align) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align || 'right';
  try { ctx.direction = 'rtl'; } catch (e) { /* older canvas */ }
  ctx.fillText(str, x, y);
}

/* ------------------------------------------------------------- screen art */
// white + blue, like the site: light app screen with the blue balance card
function drawScreen(c) {
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, R = 96;
  const INK = '#0b1220', INK2 = '#1f2a44', MUTED = '#6b7590';
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  rr(ctx, 0, 0, w, h, R);
  ctx.clip();
  let g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#f2f6ff');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  g = ctx.createRadialGradient(w * 0.75, 140, 10, w * 0.75, 140, 640);
  g.addColorStop(0, 'rgba(37,99,235,.10)'); g.addColorStop(1, 'rgba(37,99,235,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  // status bar + island
  text(ctx, '18:40', 92, 78, '600 34px ' + FONT_NUM, INK, 'left');
  ctx.fillStyle = '#0b1220'; rr(ctx, w / 2 - 118, 30, 236, 70, 35); ctx.fill();
  ctx.strokeStyle = 'rgba(11,18,32,.8)'; ctx.lineWidth = 3; rr(ctx, w - 150, 54, 62, 30, 9); ctx.stroke();
  ctx.fillStyle = INK; rr(ctx, w - 146, 58, 44, 22, 5); ctx.fill();

  // header
  text(ctx, "כספ'לה", w - 64, 206, '900 60px ' + FONT_NUM, INK);
  text(ctx, 'נובמבר 2026', w - 64, 254, '500 30px ' + FONT_HE, MUTED);
  g = ctx.createLinearGradient(54, 150, 150, 246);
  g.addColorStop(0, '#2563eb'); g.addColorStop(1, '#6366f1');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(108, 198, 48, 0, Math.PI * 2); ctx.fill();
  text(ctx, '₪', 108, 216, '900 48px ' + FONT_NUM, '#ffffff', 'center');

  // balance card
  const cx = 44, cy = 300, cw = w - 88, ch = 330;
  ctx.save();
  ctx.shadowColor = 'rgba(37,99,235,.38)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 18;
  g = ctx.createLinearGradient(cx, cy, cx + cw, cy + ch);
  g.addColorStop(0, '#3b82f6'); g.addColorStop(0.55, '#2563eb'); g.addColorStop(1, '#4f46e5');
  ctx.fillStyle = g; rr(ctx, cx, cy, cw, ch, 46); ctx.fill();
  ctx.restore();
  g = ctx.createRadialGradient(cx + cw * 0.15, cy, 10, cx + cw * 0.15, cy, 420);
  g.addColorStop(0, 'rgba(255,255,255,.25)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; rr(ctx, cx, cy, cw, ch, 46); ctx.fill();
  text(ctx, 'נשאר לחודש', cx + cw - 44, cy + 78, '600 34px ' + FONT_HE, 'rgba(255,255,255,.88)');
  text(ctx, '1,575 ₪', cx + cw - 44, cy + 196, '900 112px ' + FONT_NUM, '#ffffff');
  text(ctx, 'מתוך תקציב של 5,000 ₪', cx + cw - 44, cy + 252, '500 28px ' + FONT_HE, 'rgba(255,255,255,.8)');
  ctx.fillStyle = 'rgba(255,255,255,.28)'; rr(ctx, cx + 44, cy + 282, cw - 88, 16, 8); ctx.fill();
  const barW = (cw - 88) * 0.685;
  ctx.fillStyle = '#ffffff'; rr(ctx, cx + 44 + (cw - 88) - barW, cy + 282, barW, 16, 8); ctx.fill();

  // categories
  text(ctx, 'לפי קטגוריה', w - 64, 726, '800 36px ' + FONT_HE, INK);
  const cats = [['דיור', '1,230 ₪', 1, '#2563eb'], ['מזון', '1,100 ₪', 0.89, '#6366f1'], ['תחבורה', '510 ₪', 0.41, '#0ea5e9'], ['פנאי', '340 ₪', 0.28, '#8b5cf6']];
  cats.forEach((cRow, i) => {
    const y = 800 + i * 98;
    ctx.fillStyle = cRow[3]; ctx.beginPath(); ctx.arc(w - 78, y - 12, 12, 0, Math.PI * 2); ctx.fill();
    text(ctx, cRow[0], w - 108, y, '700 32px ' + FONT_HE, INK2);
    text(ctx, cRow[1], 64, y, '700 32px ' + FONT_NUM, INK, 'left');
    ctx.fillStyle = '#e6edfb'; rr(ctx, 64, y + 22, w - 128, 12, 6); ctx.fill();
    const bw = (w - 128) * cRow[2];
    ctx.fillStyle = cRow[3]; rr(ctx, 64 + (w - 128) - bw, y + 22, bw, 12, 6); ctx.fill();
  });

  // recent entries
  text(ctx, 'תנועות אחרונות', w - 64, 1222, '800 36px ' + FONT_HE, INK);
  const tx = [['סופר', 'היום · וואטסאפ', '245 ₪', true], ['קפה', 'היום · וואטסאפ', '45 ₪', false], ['דלק', 'אתמול · וואטסאפ', '300 ₪', false]];
  tx.forEach((t, i) => {
    const y = 1258 + i * 112;
    ctx.save();
    ctx.shadowColor = 'rgba(15,23,42,.06)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
    ctx.fillStyle = t[3] ? '#eaf1ff' : '#ffffff';
    rr(ctx, 44, y, w - 88, 96, 28); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = t[3] ? 'rgba(37,99,235,.45)' : 'rgba(15,23,42,.07)'; ctx.lineWidth = 2; rr(ctx, 44, y, w - 88, 96, 28); ctx.stroke();
    text(ctx, t[0], w - 84, y + 44, '700 32px ' + FONT_HE, INK);
    text(ctx, t[1], w - 84, y + 80, '500 24px ' + FONT_HE, MUTED);
    text(ctx, t[2], 84, y + 60, '800 36px ' + FONT_NUM, INK, 'left');
    if (t[3]) {
      ctx.fillStyle = '#2563eb'; rr(ctx, 232, y + 30, 92, 38, 19); ctx.fill();
      text(ctx, 'חדש', 278, y + 58, '800 24px ' + FONT_HE, '#ffffff', 'center');
    }
  });

  // tab bar
  ctx.save();
  ctx.shadowColor = 'rgba(15,23,42,.10)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#ffffff'; rr(ctx, 44, h - 168, w - 88, 112, 56); ctx.fill();
  ctx.restore();
  for (let i = 0; i < 4; i++) {
    const x = w - 140 - i * ((w - 280) / 3);
    ctx.fillStyle = i === 0 ? '#2563eb' : 'rgba(15,23,42,.18)';
    if (i === 0) { ctx.beginPath(); ctx.arc(x, h - 112, 22, 0, Math.PI * 2); ctx.fill(); }
    else { rr(ctx, x - 20, h - 132, 40, 40, 12); ctx.fill(); }
  }
  ctx.fillStyle = 'rgba(11,18,32,.55)'; rr(ctx, w / 2 - 90, h - 30, 180, 9, 5); ctx.fill();
  ctx.restore();
}

function drawBack(c) {
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  rr(ctx, 0, 0, w, h, 64);
  ctx.clip();
  let g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#1e1b4b'); g.addColorStop(0.55, '#1d3a8a'); g.addColorStop(1, '#0f172a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  g = ctx.createRadialGradient(w * 0.3, h * 0.25, 10, w * 0.3, h * 0.25, h * 0.7);
  g.addColorStop(0, 'rgba(129,140,248,.35)'); g.addColorStop(1, 'rgba(129,140,248,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(w / 2, h * 0.52, 74, 0, Math.PI * 2); ctx.stroke();
  text(ctx, '₪', w / 2, h * 0.52 + 32, '900 92px ' + FONT_NUM, 'rgba(255,255,255,.92)', 'center');
  text(ctx, "כספ'לה", w / 2, h * 0.52 + 150, '800 44px ' + FONT_NUM, 'rgba(255,255,255,.7)', 'center');
  ctx.restore();
}

/* ------------------------------------------------------------- mount */
export function mount(viewer, canvas, opts) {
  opts = opts || {};
  const motion = opts.motion !== false;
  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  if (room.dispose) room.dispose();
  scene.environment = envRT.texture;

  const camera = new PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 6.4);

  scene.add(new AmbientLight(0xffffff, 0.25));
  const key = new DirectionalLight(0xffffff, 1.6); key.position.set(2.5, 3, 4); scene.add(key);
  const rim = new DirectionalLight(0x93c5fd, 2.2); rim.position.set(-3.5, 1.5, -2.5); scene.add(rim);
  const fill = new DirectionalLight(0x38bdf8, 1.1); fill.position.set(3, -2, -3); scene.add(fill);

  const phone = new Group();
  scene.add(phone);
  const disposables = [envRT, pmrem];
  const add = (geo, mat) => { const m = new Mesh(geo, mat); disposables.push(geo, mat); phone.add(m); return m; };

  // body
  add(slab(W, H, 0.14, D, 0.022, 5), new MeshPhysicalMaterial({
    color: 0x2b3552, metalness: 1, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 1.2
  }));
  // front glass
  const glass = add(new ShapeGeometry(roundedShape(W - 0.03, H - 0.03, 0.12), 12), new MeshPhysicalMaterial({
    color: 0x020409, metalness: 0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.04
  }));
  glass.position.z = D / 2 + 0.0015;
  // screen
  const sc = document.createElement('canvas');
  sc.width = 820; sc.height = Math.round(820 * SCREEN_H / SCREEN_W);
  drawScreen(sc);
  const screenTex = new CanvasTexture(sc);
  screenTex.colorSpace = SRGBColorSpace;
  screenTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  disposables.push(screenTex);
  const screen = add(new PlaneGeometry(SCREEN_W, SCREEN_H), new MeshBasicMaterial({ map: screenTex, transparent: true, alphaTest: 0.5, toneMapped: false }));
  screen.position.z = D / 2 + 0.003;
  // back glass with the mark
  const bc = document.createElement('canvas');
  bc.width = 512; bc.height = Math.round(512 * (H - 0.04) / (W - 0.04));
  drawBack(bc);
  const backTex = new CanvasTexture(bc);
  backTex.colorSpace = SRGBColorSpace;
  disposables.push(backTex);
  const back = add(new PlaneGeometry(W - 0.04, H - 0.04), new MeshPhysicalMaterial({
    map: backTex, roughness: 0.32, metalness: 0.15, clearcoat: 0.9, clearcoatRoughness: 0.12, transparent: true, alphaTest: 0.5
  }));
  back.rotation.y = Math.PI;
  back.position.z = -D / 2 - 0.0015;
  // camera bump and lenses (top left when the phone shows its back)
  const bump = add(slab(0.38, 0.38, 0.1, 0.028, 0.008, 3), new MeshPhysicalMaterial({
    color: 0x1b2340, metalness: 0.6, roughness: 0.25, clearcoat: 1
  }));
  bump.position.set(W / 2 - 0.27, H / 2 - 0.27, -D / 2 - 0.012);
  const lensGeo = new CylinderGeometry(0.062, 0.062, 0.035, 32);
  const ringGeo = new CylinderGeometry(0.074, 0.074, 0.03, 32);
  const lensMat = new MeshPhysicalMaterial({ color: 0x030407, metalness: 0.3, roughness: 0.04, clearcoat: 1 });
  const ringMat = new MeshStandardMaterial({ color: 0xaab3cf, metalness: 1, roughness: 0.22 });
  disposables.push(lensGeo, ringGeo, lensMat, ringMat);
  [[-0.08, 0.08], [-0.08, -0.08], [0.09, 0]].forEach((p) => {
    const ring = new Mesh(ringGeo, ringMat); ring.rotation.x = Math.PI / 2;
    ring.position.set(bump.position.x + p[0], bump.position.y + p[1], -D / 2 - 0.03);
    const lens = new Mesh(lensGeo, lensMat); lens.rotation.x = Math.PI / 2;
    lens.position.set(ring.position.x, ring.position.y, -D / 2 - 0.028);
    phone.add(ring, lens);
  });
  // side buttons
  const btnMat = new MeshPhysicalMaterial({ color: 0x2b3552, metalness: 1, roughness: 0.3 });
  disposables.push(btnMat);
  [[-W / 2 - 0.006, 0.52, 0.17], [-W / 2 - 0.006, 0.3, 0.17], [W / 2 + 0.006, 0.42, 0.26]].forEach((b) => {
    const g = slab(0.022, b[2], 0.009, 0.04, 0.006, 2); disposables.push(g);
    const m = new Mesh(g, btnMat); m.position.set(b[0], b[1], 0); phone.add(m);
  });

  // redraw once the web fonts are in, so the Hebrew uses Heebo / Rubik
  if (document.fonts && document.fonts.load) {
    Promise.all(['900 60px Rubik', '700 32px Heebo', '500 30px Heebo'].map((f) => document.fonts.load(f, 'אבג 123'))).then(() => {
      drawScreen(sc); screenTex.needsUpdate = true;
      drawBack(bc); backTex.needsUpdate = true;
      needsFrame = true; wake();
    }).catch(() => {});
  }

  /* --------------------------------------------------------- interaction */
  const BASE_Y = -0.42, BASE_X = 0.08;
  let rotY = BASE_Y + 0.9, rotX = BASE_X, tY = BASE_Y, tX = BASE_X, scrollY = 0;
  let drag = null, lastMove = 0, vel = 0, visible = false, raf = 0, needsFrame = true, t0 = performance.now();

  const onDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, on: e.pointerType === 'mouse' };
    if (drag.on) { try { viewer.setPointerCapture(e.pointerId); } catch (err) { /* ok */ } }
    vel = 0; wake();
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      const dx = Math.abs(e.clientX - drag.x), dy = Math.abs(e.clientY - drag.y);
      if (dy > 10 && dy > dx) { drag = null; return; }
      if (dx < 6 || dx < dy) return;
      drag.on = true;
      try { viewer.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
    }
    const mx = e.clientX - drag.lx, my = e.clientY - drag.ly;
    drag.lx = e.clientX; drag.ly = e.clientY;
    tY += mx * 0.012; tX = Math.max(-0.5, Math.min(0.5, tX + my * 0.006));
    vel = mx * 0.012; lastMove = performance.now(); wake();
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.on) { tY += vel * 9; lastMove = performance.now(); }
    drag = null; wake();
  };
  viewer.addEventListener('pointerdown', onDown);
  viewer.addEventListener('pointermove', onMove);
  viewer.addEventListener('pointerup', onUp);
  viewer.addEventListener('pointercancel', onUp);

  /* --------------------------------------------------------- loop */
  function resize() {
    const r = viewer.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = camera.aspect < 0.85 ? 6.4 / Math.max(0.62, camera.aspect / 0.85) : 6.4;
    camera.updateProjectionMatrix();
    needsFrame = true; wake();
  }
  function frame(now) {
    raf = 0;
    const t = (now - t0) / 1000;
    const idle = !drag && now - lastMove > 2600;
    if (idle) {
      // drift back to the showcase angle, keeping full turns the user added
      const turns = Math.round((tY - BASE_Y) / (Math.PI * 2));
      const home = BASE_Y + turns * Math.PI * 2 + scrollY + (motion ? Math.sin(t * 0.5) * 0.16 : 0);
      tY += (home - tY) * 0.04;
      tX += (BASE_X - tX) * 0.04;
    }
    const k = drag ? 0.25 : 0.07;
    const dY = tY - rotY, dX = tX - rotX;
    rotY += dY * k; rotX += dX * k;
    phone.rotation.set(rotX, rotY, motion ? Math.sin(t * 0.8) * 0.02 : 0);
    phone.position.y = motion ? Math.sin(t * 1.1) * 0.045 : 0;
    renderer.render(scene, camera);
    needsFrame = false;
    const moving = Math.abs(dY) > 0.0005 || Math.abs(dX) > 0.0005 || !!drag;
    if (visible && !document.hidden && (motion || moving || needsFrame)) raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame); }

  const io = new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); if (visible) wake(); }, { rootMargin: '120px 0px' });
  io.observe(viewer);
  const ro = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(viewer); else window.addEventListener('resize', resize);
  const onVis = () => { if (!document.hidden) wake(); };
  document.addEventListener('visibilitychange', onVis);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); viewer.classList.remove('is-live'); visible = false; });
  resize();

  return {
    setScroll(p) { scrollY = (p - 0.5) * 1.1; if (!drag) wake(); },
    destroy() {
      visible = false; if (raf) cancelAnimationFrame(raf);
      io.disconnect(); if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      viewer.removeEventListener('pointerdown', onDown); viewer.removeEventListener('pointermove', onMove);
      viewer.removeEventListener('pointerup', onUp); viewer.removeEventListener('pointercancel', onUp);
      disposables.forEach((x) => { try { x.dispose(); } catch (e) { /* ok */ } });
      renderer.dispose();
    }
  };
}
