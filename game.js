import * as THREE from './vendor/three.module.js';

// ─── Difficulty ──────────────────────────────────────────────────────────────
const DIFFICULTY = {
  normal: {
    catHealth: 100,
    treatHeal: 35,
    treatBase: 3,        // initial-room treat count
    treatPerRoom: 2,     // base added per new room (n + currentRoom)
    boneBase: 6,
    bonePerRoom: 4,
    ambient: 2.8,
    lantern: 5.0,
    sconceWarm: 3.5,
    sconceCool: 3.0,
  },
  easy: {
    catHealth: 50,       // 2-shot kills
    treatHeal: 60,
    treatBase: 6,
    treatPerRoom: 4,
    boneBase: 9,
    bonePerRoom: 5,
    ambient: 5.5,
    lantern: 8.0,
    sconceWarm: 5.5,
    sconceCool: 5.0,
  },
};
function diff() { return DIFFICULTY[STATE.difficulty] || DIFFICULTY.normal; }

// ─── Global State ────────────────────────────────────────────────────────────
const STATE = {
  health: 100,
  bones: 30,
  diamonds: 0,
  lasers: 0,
  missiles: 0,
  dirt: 0,
  nails: 0,
  running: false,
  started: false,
  gameover: false,
  difficulty: 'normal',
  level: 'dungeon',   // 'dungeon' | 'ocean-*' | 'space-*'
};
const DUNGEON_ROOMS = 3;       // rooms 1..3 are dungeon
const OCEAN_LEVELS = ['ocean-surface', 'ocean-underwater', 'pirate-ship']; // rooms 4..6
const SPACE_LEVELS = ['space-cockpit', 'pluto-surface', 'neptune-approach', 'neptune-surface', 'uranus-surface', 'saturn-approach', 'saturn-surface', 'jupiter-surface', 'cat-ship-hijack']; // rooms 7..15
const OCEAN_BOUND = 18;
const UNDERWATER_BOUND = 22;
const SHIP_BOUND_X = 4.5;       // pirate ship deck half-width
const SHIP_BOUND_Z = 16;        // pirate ship deck half-length
const DUNGEON_BOUND = 9.4;
const SPACE_BOUND_X = 1.4;      // cockpit: tiny side-to-side steering range
const SPACE_BOUND_Z = 0.4;      // cockpit: fore/aft is locked
const PLUTO_BOUND = 22;         // pluto surface: large ice plain
const NEPTUNE_BOUND = 24;       // neptune surface: ruined city plaza
const URANUS_BOUND  = 22;       // uranus surface: alien outpost
const SATURN_BOUND  = 24;       // saturn surface: red gas plain
const JUPITER_BOUND = 26;       // jupiter surface: stormy cloud deck

function levelForRoom(n) {
  if (n <= DUNGEON_ROOMS) return 'dungeon';
  let idx = n - DUNGEON_ROOMS - 1;
  if (idx < OCEAN_LEVELS.length) return OCEAN_LEVELS[idx];
  idx -= OCEAN_LEVELS.length;
  return SPACE_LEVELS[idx] || null;
}
function isOceanLike(level) {
  return OCEAN_LEVELS.includes(level);
}
function isSpaceLike(level) {
  return SPACE_LEVELS.includes(level);
}
function levelLabel(level, roomNum) {
  if (level === 'dungeon') return String(roomNum);
  if (level === 'ocean-surface') return 'OCEAN';
  if (level === 'ocean-underwater') return 'DEEP';
  if (level === 'pirate-ship') return 'PIRATE SHIP';
  if (level === 'space-cockpit') return 'TO PLUTO';
  if (level === 'pluto-surface') return 'PLUTO';
  if (level === 'neptune-approach') return 'TO NEPTUNE';
  if (level === 'neptune-surface') return 'NEPTUNE';
  if (level === 'uranus-surface') return 'URANUS';
  if (level === 'saturn-approach') return 'TO SATURN';
  if (level === 'saturn-surface') return 'SATURN';
  if (level === 'jupiter-surface') return 'JUPITER';
  if (level === 'cat-ship-hijack') return 'CAT SHIP';
  return '?';
}
function levelBounds(level) {
  if (level === 'ocean-surface') return [OCEAN_BOUND, OCEAN_BOUND];
  if (level === 'ocean-underwater') return [UNDERWATER_BOUND, UNDERWATER_BOUND];
  if (level === 'pirate-ship') return [SHIP_BOUND_X, SHIP_BOUND_Z];
  if (level === 'space-cockpit') return [SPACE_BOUND_X, SPACE_BOUND_Z];
  if (level === 'pluto-surface') return [PLUTO_BOUND, PLUTO_BOUND];
  if (level === 'neptune-approach') return [SPACE_BOUND_X, SPACE_BOUND_Z];
  if (level === 'neptune-surface') return [NEPTUNE_BOUND, NEPTUNE_BOUND];
  if (level === 'uranus-surface') return [URANUS_BOUND, URANUS_BOUND];
  if (level === 'saturn-approach') return [SPACE_BOUND_X, SPACE_BOUND_Z];
  if (level === 'saturn-surface') return [SATURN_BOUND, SATURN_BOUND];
  if (level === 'jupiter-surface') return [JUPITER_BOUND, JUPITER_BOUND];
  if (level === 'cat-ship-hijack') return [SPACE_BOUND_X, SPACE_BOUND_Z];   // small cockpit
  return [DUNGEON_BOUND, DUNGEON_BOUND];
}

const KEYS = {};
const MOUSE = { x: 0, y: 0, dx: 0, dy: 0, locked: false };

// Reusable scratch vectors so hot per-frame loops don't allocate new THREE.Vector3
// every frame — was the major cause of periodic GC pauses (1-2 sec freezes).
const SCRATCH = {
  vA: new THREE.Vector3(),
  vB: new THREE.Vector3(),
  vC: new THREE.Vector3(),
  vD: new THREE.Vector3(),
};
const MAX_PARTICLES = 80;   // hard cap on scene.userData.particles so explosions can't unbound the heap

// Module-level materials reused across levels — never dispose these on
// level transitions or every subsequent throwBone/Laser/etc will render broken.
const PERSISTENT_MATS = new Set();
function persistMat(m) { PERSISTENT_MATS.add(m); return m; }

// Free GPU resources for everything under the given root (geometries + any
// materials that aren't on the persistent list). Safe to call before
// scene.remove(child) on each top-level scene child during a level switch.
function disposeObjectTree(root) {
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    if (!node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const m of mats) {
      if (PERSISTENT_MATS.has(m)) continue;
      for (const key of ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'roughnessMap', 'metalnessMap']) {
        if (m[key]) m[key].dispose();
      }
      m.dispose();
    }
  });
}

// ─── Touch input (iPad / iPhone) ─────────────────────────────────────────────
// Activated when (pointer: coarse). Coexists with desktop controls — both work.
const TOUCH = {
  active: false,            // becomes true after initTouchControls runs
  moveX: 0, moveZ: 0,       // normalized left-stick (-1..1); z = forward (negative)
  lookX: 0, lookY: 0,       // normalized right-stick (-1..1) — continuous look rate
  firePulse: false,         // set on touchstart of fire button — consumed per frame
};

function isTouchDevice() {
  // URL override lets you force either mode for testing: ?touch=1 / ?touch=0
  const force = new URLSearchParams(location.search).get('touch');
  if (force === '1') return true;
  if (force === '0') return false;
  // Real touch requires both: an actual touch surface AND coarse as the primary pointer.
  // A touchscreen laptop with mouse primary correctly returns false here.
  const hasTouchPoints = (navigator.maxTouchPoints || 0) > 0;
  const coarsePrimary = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  return hasTouchPoints && coarsePrimary;
}

// Wrapper used everywhere instead of canvas.requestPointerLock() directly.
// On touch devices it just marks the cursor "engaged" since pointer-lock is meaningless.
function lockPointer() {
  if (isTouchDevice()) {
    MOUSE.locked = true;
    hidePlayHint();
    return;
  }
  document.getElementById('canvas').requestPointerLock();
}

function applyTouchClasses() {
  if (!document.body.classList.contains('touch-mode')) return;
  document.body.classList.toggle('narrow', Math.min(window.innerWidth, window.innerHeight) <= 700);
  document.body.classList.toggle('portrait', window.innerHeight > window.innerWidth);
}

function initTouchControls() {
  if (!isTouchDevice()) return;
  TOUCH.active = true;

  // Mark body so CSS can scope every touch-only style. Desktop never gets these
  // even if (pointer: coarse) is accidentally matched by something.
  document.body.classList.add('touch-mode');
  applyTouchClasses();
  window.addEventListener('resize', applyTouchClasses);
  window.addEventListener('orientationchange', applyTouchClasses);
  const ui = document.getElementById('touch-ui');
  if (ui) ui.style.display = 'block';

  // Pointer lock is meaningless on touch — pretend engaged so existing input flows work
  MOUSE.locked = true;
  hidePlayHint();

  setupJoystick('joystick-left', (nx, ny) => {
    // Left stick: nx = strafe, ny = forward/back (ny negative = up on screen = forward)
    TOUCH.moveX = nx;
    TOUCH.moveZ = ny;
  });
  setupJoystick('joystick-right', (nx, ny) => {
    // Right stick: continuous look rate. ny negative = look up
    TOUCH.lookX = nx;
    TOUCH.lookY = ny;
  });

  // Auto-fire helper: shoots immediately on press, then on a fixed interval while held.
  // Touch-only — desktop uses Space/Click via the existing onClick handler so we don't
  // risk a stuck setInterval if a mousedown/mouseup pair is lost.
  function bindAutoFire(btnId, action, intervalMs) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    let timerId = null;
    let touchId = null;
    const start = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!STATE.started || STATE.gameover) return;
      if (e.changedTouches && e.changedTouches[0]) touchId = e.changedTouches[0].identifier;
      action();
      if (timerId !== null) return;
      timerId = setInterval(() => {
        if (!STATE.started || STATE.gameover) { stop(); return; }
        action();
      }, intervalMs);
    };
    const stop = (e) => {
      if (e && e.changedTouches && touchId !== null) {
        let match = false;
        for (const t of e.changedTouches) {
          if (t.identifier === touchId) { match = true; break; }
        }
        if (!match) return;
      }
      if (timerId !== null) { clearInterval(timerId); timerId = null; }
      touchId = null;
    };
    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('touchend', stop, { passive: false });
    btn.addEventListener('touchcancel', stop, { passive: false });
  }

  // FIRE: 8 shots/sec (matches feel of a manual click-spammer but consistent).
  // Cockpit laser already paces nicely; surface bones/dirt/nails benefit too.
  bindAutoFire('touch-fire', () => throwAmmo(), 130);
  // Missile: 1.5/sec — heavier weapon, don't let people spam.
  bindAutoFire('touch-missile', () => throwMissile(), 650);

  // Dev menu corner button — replaces the ` key on touch
  const devBtn = document.getElementById('touch-dev');
  if (devBtn) {
    const dev = (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleDevMenu();
    };
    devBtn.addEventListener('touchstart', dev, { passive: false });
    devBtn.addEventListener('click', dev);
  }
}

function setupJoystick(baseId, onChange) {
  const base = document.getElementById(baseId);
  if (!base) return;
  const stick = base.querySelector('.stick');
  let touchId = null;
  let baseRect = null;
  let radius = 0;

  const recompute = () => {
    baseRect = base.getBoundingClientRect();
    radius = baseRect.width / 2;
  };

  const setStickFromClient = (clientX, clientY) => {
    if (!baseRect) recompute();
    const cx = baseRect.left + radius;
    const cy = baseRect.top + radius;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const len = Math.sqrt(dx*dx + dy*dy);
    const maxDrag = radius * 0.85;
    if (len > maxDrag) {
      dx = dx / len * maxDrag;
      dy = dy / len * maxDrag;
    }
    stick.style.transform = `translate(${dx}px, ${dy}px)`;
    // Normalize to (-1..1)
    onChange(dx / maxDrag, dy / maxDrag);
  };

  base.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (touchId !== null) return;
    const t = e.changedTouches[0];
    touchId = t.identifier;
    recompute();
    setStickFromClient(t.clientX, t.clientY);
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (touchId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier === touchId) {
        e.preventDefault();
        setStickFromClient(t.clientX, t.clientY);
        return;
      }
    }
  }, { passive: false });

  const end = (e) => {
    if (touchId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier === touchId) {
        e.preventDefault();
        touchId = null;
        stick.style.transform = 'translate(0, 0)';
        onChange(0, 0);
        return;
      }
    }
  };
  document.addEventListener('touchend', end, { passive: false });
  document.addEventListener('touchcancel', end, { passive: false });

  window.addEventListener('resize', () => { baseRect = null; });
}
const PROJECTILES = [];
const ENEMY_PROJECTILES = [];   // shots fired AT the player (alien lasers, etc.)
const ENEMIES = [];
const BONE_PICKUPS = [];
const TREAT_PICKUPS = [];
const DIAMOND_PICKUPS = [];
let currentRoom = 1;
let transitioning = false;
let roomCleared = false;
let portalActive = false;
let clock, scene, camera, renderer;
let playerYaw = 0, playerPitch = 0;
let playerVelocityY = 0;
const playerState = { crackFalling: false };
const GRAVITY = -20;
const PLAYER_SPEED = 6;
const RUN_MULT = 1.8;
const PLAYER_HEIGHT = 1.1;

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  clock = new THREE.Clock();

  // Renderer (cheaper settings on touch devices — DPR=1, no antialias, no shadows).
  // Note: no powerPreference flag — letting the browser pick. Forcing 'high-performance'
  // on macOS triggered discrete-GPU switching hitches and visual glitches on desktops.
  const touchMode = isTouchDevice();
  const canvas = document.getElementById('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !touchMode });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(touchMode ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !touchMode;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x050005);
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 4.5;

  // Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0005, 0.07);

  // Camera (first-person)
  camera = new THREE.PerspectiveCamera(85, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(0, PLAYER_HEIGHT, 0);

  buildRoom(1);
  spawnBonePickups(diff().boneBase);
  spawnTreatPickups(diff().treatBase);
  buildDogViewModel();
  addLighting();
  drawDogFace(STATE.health);

  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', e => {
    // Prevent arrow keys / space from scrolling the page
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
      e.preventDefault();
    }
    KEYS[e.code] = true;
    if (e.code === 'Backquote') {
      e.preventDefault();
      toggleDevMenu();
      return;
    }
    if (e.code === 'KeyF' && STATE.started && !STATE.gameover) {
      e.preventDefault();
      throwMissile();
      return;
    }
    if (STATE.gameover) {
      if (e.code === 'KeyR') restartGame();
      if (e.code === 'KeyL' && (currentRoom > 1 || STATE.level !== 'dungeon')) restartLevel();
    }
  });
  window.addEventListener('keyup',   e => { KEYS[e.code] = false; });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('click', onClick);
  document.addEventListener('pointerlockchange', () => {
    if (isTouchDevice()) return;     // touch devices stay "locked" via TOUCH.active
    MOUSE.locked = document.pointerLockElement === canvas;
    if (MOUSE.locked) hidePlayHint();
    else if (STATE.started && !STATE.gameover) showPlayHint();
  });

  initTouchControls();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ─── Ocean Level: Surface ────────────────────────────────────────────────────
function buildOceanSurface() {
  // ── Water surface ──
  const waterGeo = new THREE.PlaneGeometry(80, 80, 30, 30);   // 30×30 = 900 verts, was 60×60 = 3600
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1a5b8a,
    roughness: 0.35,
    metalness: 0.35,
    emissive: 0x0a2b4a,
    emissiveIntensity: 0.4,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.receiveShadow = true;
  scene.add(water);
  scene.userData.water = water;
  // Stash original Z positions for wave animation
  const pos = waterGeo.attributes.position;
  const baseZ = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) baseZ[i] = pos.getZ(i);
  scene.userData.waterBaseZ = baseZ;

  // ── Sky dome (large back-side sphere) ──
  const skyGeo = new THREE.SphereGeometry(60, 24, 16);
  const skyMat = new THREE.MeshBasicMaterial({
    color: 0xa6d8f0,
    side: THREE.BackSide,
    fog: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  // ── Distant horizon islands (silhouettes for depth) ──
  const islandMat = new THREE.MeshBasicMaterial({ color: 0x4a6678, fog: true });
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + 0.3;
    const r = 35;
    const island = new THREE.Mesh(
      new THREE.SphereGeometry(2 + Math.random() * 2, 8, 6),
      islandMat
    );
    island.position.set(Math.cos(ang) * r, -1, Math.sin(ang) * r);
    island.scale.set(1.5, 0.4, 1.5);
    scene.add(island);
  }

  // ── Pirate boat (center) ──
  buildPirateBoat();

  // ── Portal on the boat deck (inactive until waves cleared) ──
  buildOceanPortal();

  // ── Lighting ──
  addOceanLighting();
}

function buildPirateBoat() {
  const boat = new THREE.Group();
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x4a2a14, roughness: 0.9 });
  const woodLight = new THREE.MeshStandardMaterial({ color: 0x6a4020, roughness: 0.85 });
  const sailMat = new THREE.MeshStandardMaterial({
    color: 0xe8dcc0, roughness: 0.95, side: THREE.DoubleSide,
  });

  // Hull bottom (long flat bottom)
  const hull = new THREE.Mesh(new THREE.BoxGeometry(5, 1.4, 9), woodDark);
  hull.position.y = 0.5;
  hull.castShadow = true;
  hull.receiveShadow = true;
  boat.add(hull);

  // Hull sides (rims)
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 9), woodLight);
    side.position.set(sx * 2.5, 1.4, 0);
    boat.add(side);
  }
  // Bow + stern caps
  const bow = new THREE.Mesh(new THREE.BoxGeometry(5, 0.8, 0.3), woodLight);
  bow.position.set(0, 1.4, -4.5);
  boat.add(bow);
  const stern = new THREE.Mesh(new THREE.BoxGeometry(5, 1.2, 0.3), woodLight);
  stern.position.set(0, 1.6, 4.5);
  boat.add(stern);

  // Deck (walkable top)
  const deck = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.15, 8.7), woodLight);
  deck.position.y = 1.25;
  deck.receiveShadow = true;
  boat.add(deck);

  // Bow point (triangular front using cone)
  const bowPoint = new THREE.Mesh(new THREE.ConeGeometry(2.5, 2.5, 4), woodDark);
  bowPoint.rotation.x = Math.PI / 2;
  bowPoint.rotation.z = Math.PI / 4;
  bowPoint.position.set(0, 0.7, -5.5);
  bowPoint.scale.y = 0.5;
  boat.add(bowPoint);

  // Mast
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 8, 10), woodDark);
  mast.position.set(0, 5.2, -1);
  mast.castShadow = true;
  boat.add(mast);

  // Crossbeam
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4.5, 8), woodDark);
  beam.rotation.z = Math.PI / 2;
  beam.position.set(0, 7.5, -1);
  boat.add(beam);

  // Sail
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), sailMat);
  sail.position.set(0, 5.4, -1.02);
  boat.add(sail);
  // Skull on sail (jolly roger-ish)
  const skullMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, side: THREE.DoubleSide });
  const skull = new THREE.Mesh(new THREE.CircleGeometry(0.6, 12), skullMat);
  skull.position.set(0, 5.4, -1.0);
  boat.add(skull);

  // Flag at top
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), new THREE.MeshBasicMaterial({ color: 0x1a1a1a, side: THREE.DoubleSide }));
  flag.position.set(0.5, 9.0, -1);
  boat.add(flag);

  // Boarding ramp (back of boat, accessible)
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.15, 3.5), woodLight);
  ramp.rotation.x = -0.35;
  ramp.position.set(0, 0.6, 6.0);
  ramp.receiveShadow = true;
  boat.add(ramp);

  scene.add(boat);
  scene.userData.boat = boat;
}

function buildOceanPortal() {
  const portal = new THREE.Group();

  // Outer ring (torus)
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a4a,
    emissive: 0x4400aa,
    emissiveIntensity: 1.5,
    metalness: 0.7,
    roughness: 0.4,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.12, 10, 28), ringMat);
  portal.add(ring);

  // Inner shimmer disc
  const discMat = new THREE.MeshBasicMaterial({
    color: 0x6a30c0,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.9, 24), discMat);
  portal.add(disc);

  // Glow light
  const glow = new THREE.PointLight(0x9a40ff, 0.8, 6, 2);
  portal.add(glow);

  portal.position.set(0, 2.6, 1.5);  // floating above deck near mast
  portal.rotation.x = -0.15;
  scene.add(portal);
  scene.userData.portal = portal;
  scene.userData.portalRing = ring;
  scene.userData.portalDisc = disc;
  scene.userData.portalLight = glow;
  portalActive = false;
}

// ─── Ocean Level: Underwater ─────────────────────────────────────────────────
function buildUnderwater() {
  // Seafloor (sandy / rocky)
  const floorGeo = new THREE.PlaneGeometry(70, 70, 50, 50);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a4858, roughness: 0.9 });
  // Procedurally bumpy seafloor
  const pos = floorGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, Math.sin(x * 0.4) * 0.25 + Math.cos(y * 0.35) * 0.25 + (Math.random() - 0.5) * 0.15);
  }
  floorGeo.computeVertexNormals();
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.4;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling (water surface from below) — semi-transparent shimmering
  const ceilMat = new THREE.MeshBasicMaterial({
    color: 0x3a8ab8, transparent: true, opacity: 0.45, side: THREE.DoubleSide, fog: true,
  });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), ceilMat);
  ceil.rotation.x = -Math.PI / 2;
  ceil.position.y = 11;
  scene.add(ceil);

  // Coral / rocks scattered around
  const coralColors = [0xff5a7a, 0xff9040, 0xa040c0, 0xffb060];
  for (let i = 0; i < 14; i++) {
    const c = coralColors[i % coralColors.length];
    const coralMat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.15, roughness: 0.7 });
    const coral = new THREE.Mesh(new THREE.ConeGeometry(0.3 + Math.random() * 0.4, 0.6 + Math.random() * 1.4, 5), coralMat);
    let cx, cz;
    do {
      cx = (Math.random() - 0.5) * 36;
      cz = (Math.random() - 0.5) * 36;
    } while (cx*cx + cz*cz < 30);
    coral.position.set(cx, 0.2, cz);
    coral.rotation.y = Math.random() * Math.PI * 2;
    coral.castShadow = true;
    scene.add(coral);
  }

  // Seaweed strands (animated sway)
  const seaweeds = [];
  const seaweedMat = new THREE.MeshStandardMaterial({ color: 0x3a8050, roughness: 0.7 });
  for (let i = 0; i < 16; i++) {
    const h = 1.5 + Math.random() * 1.5;
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.35, h), seaweedMat);
    let wx, wz;
    do {
      wx = (Math.random() - 0.5) * 38;
      wz = (Math.random() - 0.5) * 38;
    } while (wx*wx + wz*wz < 25);
    w.position.set(wx, h/2 - 0.2, wz);
    w.userData.phase = Math.random() * Math.PI * 2;
    seaweeds.push(w);
    scene.add(w);
  }
  scene.userData.seaweeds = seaweeds;

  // Floating bubbles (rise and reset)
  const bubbles = [];
  const bubbleMat = new THREE.MeshBasicMaterial({ color: 0xcfe9ff, transparent: true, opacity: 0.55 });
  for (let i = 0; i < 40; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.07 + Math.random() * 0.06, 6, 5), bubbleMat);
    b.position.set(
      (Math.random() - 0.5) * 40,
      Math.random() * 11 - 1,
      (Math.random() - 0.5) * 40,
    );
    b.userData.rise = 0.5 + Math.random() * 0.7;
    b.userData.phase = Math.random() * Math.PI * 2;
    bubbles.push(b);
    scene.add(b);
  }
  scene.userData.bubbles = bubbles;

  // Sunken shipwreck (silhouette) on one side
  const wreckMat = new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.95 });
  const wreck = new THREE.Mesh(new THREE.BoxGeometry(6, 1.5, 2.5), wreckMat);
  wreck.position.set(-12, 0.6, -10);
  wreck.rotation.z = 0.25;
  scene.add(wreck);
  const wreckMast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 4, 8), wreckMat);
  wreckMast.position.set(-12, 2.5, -10);
  wreckMast.rotation.z = 0.35;
  scene.add(wreckMast);

  // Portal in the center, hovering above the seafloor (inactive until cleared)
  buildOceanPortal();
  if (scene.userData.portal) scene.userData.portal.position.set(0, 1.8, -2);

  // Lighting: dim deep-sea
  const amb = new THREE.AmbientLight(0x4080a0, 0.9);
  scene.add(amb);
  scene.userData.ambient = amb;
  const sun = new THREE.DirectionalLight(0xb0d8ff, 1.2);
  sun.position.set(5, 15, 5);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0x4080a8, 0x1a2030, 0.7);
  scene.add(hemi);
}

// ─── Ocean Level: Pirate Ship Deck ───────────────────────────────────────────
function buildPirateShip() {
  // Distant water surface visible over the railings
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x2a6090, roughness: 0.5, metalness: 0.4 });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = -1.5;
  scene.add(water);

  // Sky dome
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(70, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x8ab8d8, side: THREE.BackSide, fog: false })
  );
  scene.add(sky);

  // Distant horizon ships
  const shipMat = new THREE.MeshBasicMaterial({ color: 0x2a3a4a, fog: true });
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.7;
    const r = 50;
    const s = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 1.5), shipMat);
    s.position.set(Math.cos(ang) * r, -0.5, Math.sin(ang) * r);
    scene.add(s);
  }

  // ── The Player's Pirate Ship ──
  const ship = new THREE.Group();
  const woodDark  = new THREE.MeshStandardMaterial({ color: 0x4a2a14, roughness: 0.9 });
  const woodLight = new THREE.MeshStandardMaterial({ color: 0x6a4020, roughness: 0.85 });
  const woodPlank = new THREE.MeshStandardMaterial({ color: 0x8a5a30, roughness: 0.8 });
  const sailMat   = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.95, side: THREE.DoubleSide });
  const sashMat   = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, side: THREE.DoubleSide });

  // Hull (long boat shape — block)
  const hull = new THREE.Mesh(new THREE.BoxGeometry(10, 2.5, 34), woodDark);
  hull.position.y = -0.25;
  hull.receiveShadow = true;
  hull.castShadow = true;
  ship.add(hull);

  // Deck (walkable top)
  const deck = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.2, 33.6), woodPlank);
  deck.position.y = 1.1;
  deck.receiveShadow = true;
  ship.add(deck);

  // Plank lines on deck (visual stripes)
  for (let i = -15; i <= 15; i += 1.5) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.05, 0.04), woodDark);
    line.position.set(0, 1.21, i);
    ship.add(line);
  }

  // Side railings
  for (const sx of [-1, 1]) {
    const railTop = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 33.6), woodLight);
    railTop.position.set(sx * 4.9, 2.3, 0);
    ship.add(railTop);
    // Vertical posts
    for (let z = -16; z <= 16; z += 1.8) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.0, 0.2), woodLight);
      post.position.set(sx * 4.9, 1.7, z);
      ship.add(post);
    }
  }

  // Stern (back) — taller poop deck
  const poop = new THREE.Mesh(new THREE.BoxGeometry(9.6, 1.0, 4), woodPlank);
  poop.position.set(0, 1.7, 15);
  ship.add(poop);
  // Stern back wall
  const sternWall = new THREE.Mesh(new THREE.BoxGeometry(9.8, 3.5, 0.3), woodDark);
  sternWall.position.set(0, 1.5, 17);
  ship.add(sternWall);

  // Bow point
  const bow = new THREE.Mesh(new THREE.ConeGeometry(5, 4, 4), woodDark);
  bow.rotation.x = Math.PI / 2;
  bow.rotation.z = Math.PI / 4;
  bow.position.set(0, 0.2, -19);
  bow.scale.y = 0.5;
  ship.add(bow);

  // Mast 1 (main)
  const mast1 = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.35, 14, 12), woodDark);
  mast1.position.set(0, 7, -3);
  mast1.castShadow = true;
  ship.add(mast1);
  const beam1 = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 7, 8), woodDark);
  beam1.rotation.z = Math.PI / 2;
  beam1.position.set(0, 10, -3);
  ship.add(beam1);
  const sail1 = new THREE.Mesh(new THREE.PlaneGeometry(6.8, 6.5), sailMat);
  sail1.position.set(0, 7, -3.05);
  ship.add(sail1);
  const skull1 = new THREE.Mesh(new THREE.CircleGeometry(0.8, 16), sashMat);
  skull1.position.set(0, 7, -3.02);
  ship.add(skull1);

  // Mast 2 (smaller, front)
  const mast2 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 11, 10), woodDark);
  mast2.position.set(0, 5.5, -12);
  ship.add(mast2);
  const beam2 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 5, 8), woodDark);
  beam2.rotation.z = Math.PI / 2;
  beam2.position.set(0, 8, -12);
  ship.add(beam2);
  const sail2 = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.5), sailMat);
  sail2.position.set(0, 5.5, -12.05);
  ship.add(sail2);

  // Flag at top of main mast
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), sashMat);
  flag.position.set(0.8, 13.5, -3);
  ship.add(flag);

  // Barrels along the rails
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x6a3a1a, roughness: 0.85 });
  const barrelHoopMat = new THREE.MeshStandardMaterial({ color: 0x3a2a14, metalness: 0.4, roughness: 0.5 });
  const barrelPositions = [[-3.5, -8], [3.5, -8], [-3.5, 6], [3.5, 6], [-3.5, 12]];
  for (const [bx, bz] of barrelPositions) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.1, 12), barrelMat);
    barrel.position.set(bx, 1.75, bz);
    ship.add(barrel);
    for (const hy of [-0.4, 0, 0.4]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.51, 0.04, 6, 16), barrelHoopMat);
      hoop.rotation.x = Math.PI / 2;
      hoop.position.set(bx, 1.75 + hy, bz);
      ship.add(hoop);
    }
  }

  // Cannons at the sides
  const cannonMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.7, roughness: 0.4 });
  for (const [cx, cz] of [[-4.4, -3], [4.4, -3], [-4.4, 3], [4.4, 3]]) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.4, 12), cannonMat);
    tube.rotation.z = Math.PI / 2;
    tube.position.set(cx, 1.5, cz);
    ship.add(tube);
  }

  // Wheel at the stern
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x7a4a20, roughness: 0.7 });
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.07, 8, 16), wheelMat);
  wheel.rotation.y = Math.PI / 2;
  wheel.position.set(0, 2.8, 14);
  ship.add(wheel);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.3, 6), wheelMat);
    spoke.rotation.z = a;
    spoke.position.set(0, 2.8, 14);
    ship.add(spoke);
  }

  scene.add(ship);
  scene.userData.ship = ship;

  // Portal at the BOW of the ship (front, inactive until waves cleared)
  buildOceanPortal();
  if (scene.userData.portal) {
    scene.userData.portal.position.set(0, 3.4, -15);
  }

  // ── Lighting ──
  const amb = new THREE.AmbientLight(0xffffff, 1.2);
  scene.add(amb);
  scene.userData.ambient = amb;
  const sun = new THREE.DirectionalLight(0xfff1c0, 2.4);
  sun.position.set(10, 25, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(1024);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xb8e0ff, 0x2a4858, 0.9);
  scene.add(hemi);
}

// ─── Space Level: Cockpit + Star Field ───────────────────────────────────────
function buildSpaceCockpit() {
  // The cockpit is a small enclosed shell around the player with a viewport facing -Z.
  // The world outside scrolls toward the camera at near-light speed.

  // ── Star field ──
  const starGeo = new THREE.BufferGeometry();
  const STAR_COUNT = isTouchDevice() ? 400 : 700;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    starPos[i*3 + 0] = (Math.random() - 0.5) * 80;
    starPos[i*3 + 1] = (Math.random() - 0.5) * 80;
    starPos[i*3 + 2] = -Math.random() * 220;  // all ahead of camera
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 0.18, sizeAttenuation: true,
    transparent: true, opacity: 0.95, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);
  scene.userData.stars = stars;

  // Streak lines (longer trailing stars to sell the speed)
  const streakCount = isTouchDevice() ? 70 : 130;
  const streakGeo = new THREE.BufferGeometry();
  const streakPos = new Float32Array(streakCount * 6); // pairs of points (line segments)
  for (let i = 0; i < streakCount; i++) {
    const x = (Math.random() - 0.5) * 45;
    const y = (Math.random() - 0.5) * 30;
    const z = -Math.random() * 180;
    streakPos[i*6 + 0] = x; streakPos[i*6 + 1] = y; streakPos[i*6 + 2] = z;
    streakPos[i*6 + 3] = x; streakPos[i*6 + 4] = y; streakPos[i*6 + 5] = z + 2.5;
  }
  streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3));
  const streaks = new THREE.LineSegments(
    streakGeo,
    new THREE.LineBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0.6, fog: false })
  );
  scene.add(streaks);
  scene.userData.streaks = streaks;

  // ── Distant Pluto (far ahead, grows over time as level progresses) ──
  const plutoMat = new THREE.MeshStandardMaterial({
    color: 0xc8a87a, roughness: 0.95, emissive: 0x3a2a18, emissiveIntensity: 0.4,
  });
  const pluto = new THREE.Mesh(new THREE.SphereGeometry(4, 32, 24), plutoMat);
  pluto.position.set(0, 0, -160);
  scene.add(pluto);
  scene.userData.pluto = pluto;

  // Pluto's pale moon (Charon)
  const charon = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0x8a8898, roughness: 0.9 })
  );
  charon.position.set(8, 1.5, -158);
  scene.add(charon);
  scene.userData.charon = charon;

  // ── Cockpit shell (player POV is inside this) ──
  const cockpit = new THREE.Group();
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x202830, roughness: 0.6, metalness: 0.4 });
  const trimMat  = new THREE.MeshStandardMaterial({ color: 0x404a55, roughness: 0.4, metalness: 0.7 });
  const consoleMat = new THREE.MeshStandardMaterial({
    color: 0x141820, roughness: 0.5, metalness: 0.3,
    emissive: 0x002a3a, emissiveIntensity: 0.4,
  });

  // Floor
  const floor = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, 3), panelMat);
  floor.position.set(0, -0.05, 0.5);
  cockpit.add(floor);
  // Ceiling
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, 3), panelMat);
  ceil.position.set(0, 2.2, 0.5);
  cockpit.add(ceil);
  // Rear wall
  const rear = new THREE.Mesh(new THREE.BoxGeometry(4, 2.3, 0.1), panelMat);
  rear.position.set(0, 1.05, 2);
  cockpit.add(rear);
  // Side walls
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.3, 3.1), panelMat);
    side.position.set(sx * 2, 1.05, 0.5);
    cockpit.add(side);
  }
  // Viewport frame (top trim above viewport)
  const topFrame = new THREE.Mesh(new THREE.BoxGeometry(4, 0.25, 0.2), trimMat);
  topFrame.position.set(0, 1.85, -1);
  cockpit.add(topFrame);
  // Viewport frame (bottom trim = top edge of dashboard)
  const botFrame = new THREE.Mesh(new THREE.BoxGeometry(4, 0.15, 0.2), trimMat);
  botFrame.position.set(0, 0.7, -1);
  cockpit.add(botFrame);
  // Side pillars (frame the viewport)
  for (const sx of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.3, 0.25), trimMat);
    pillar.position.set(sx * 1.85, 1.25, -1);
    cockpit.add(pillar);
  }

  // Dashboard (slanted console under the viewport)
  const dash = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.18, 0.9), consoleMat);
  dash.rotation.x = -0.35;
  dash.position.set(0, 0.45, -0.5);
  cockpit.add(dash);

  // Dashboard glowing buttons (rows of small emissive squares)
  const buttonColors = [0x00ff88, 0xff6644, 0xffd060, 0x40c8ff, 0xff40c8];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 9; col++) {
      const c = buttonColors[(row * 9 + col) % buttonColors.length];
      const btn = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.04, 0.12),
        new THREE.MeshBasicMaterial({ color: c })
      );
      const x = -1.5 + col * 0.38;
      const z = -0.78 + row * 0.22;
      const y = 0.58 + row * 0.08;
      btn.position.set(x, y, z);
      btn.rotation.x = -0.35;
      btn.userData.blinkPhase = Math.random() * Math.PI * 2;
      btn.userData.baseColor = c;
      cockpit.add(btn);
      scene.userData.dashButtons = scene.userData.dashButtons || [];
      scene.userData.dashButtons.push(btn);
    }
  }

  // Central screen on the dashboard (radar-style)
  const radar = new THREE.Mesh(
    new THREE.CircleGeometry(0.25, 24),
    new THREE.MeshBasicMaterial({ color: 0x002818 })
  );
  radar.rotation.x = -0.35 - Math.PI / 2;
  radar.position.set(0, 0.62, -0.55);
  cockpit.add(radar);
  const radarRing = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.25, 24),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide })
  );
  radarRing.rotation.x = -0.35 - Math.PI / 2;
  radarRing.position.set(0, 0.63, -0.55);
  cockpit.add(radarRing);
  // Radar sweep line
  const sweep = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.02),
    new THREE.MeshBasicMaterial({ color: 0x66ffaa, transparent: true, opacity: 0.7 })
  );
  sweep.rotation.x = -0.35 - Math.PI / 2;
  sweep.position.set(0, 0.64, -0.55);
  cockpit.add(sweep);
  scene.userData.radarSweep = sweep;

  // Cannon barrels mounted under the viewport (visible to the player)
  const cannonMat = new THREE.MeshStandardMaterial({ color: 0x222a33, metalness: 0.8, roughness: 0.3 });
  for (const sx of [-1, 1]) {
    const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.2, 10), cannonMat);
    cannon.rotation.x = Math.PI / 2;
    cannon.position.set(sx * 1.3, 0.85, -1.4);
    cockpit.add(cannon);
    // Glowing tip
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x40ffff })
    );
    tip.position.set(sx * 1.3, 0.85, -2.0);
    cockpit.add(tip);
    scene.userData.cannonTips = scene.userData.cannonTips || [];
    scene.userData.cannonTips.push(tip);
  }

  scene.add(cockpit);
  scene.userData.cockpit = cockpit;

  // ── Lighting ──
  const amb = new THREE.AmbientLight(0x4060a0, 0.6);
  scene.add(amb);
  scene.userData.ambient = amb;
  // Soft dashboard glow
  const dashGlow = new THREE.PointLight(0x40c8ff, 1.4, 4, 2);
  dashGlow.position.set(0, 0.9, -0.5);
  scene.add(dashGlow);
  // Cool rim light from outside the viewport
  const rim = new THREE.DirectionalLight(0xbfd8ff, 0.9);
  rim.position.set(0, 1, -3);
  scene.add(rim);

  // Track progression to Pluto: 0 = far away, 1 = crash
  scene.userData.spaceProgress = 0;
  scene.userData.spacePhase = 'fight'; // 'fight' | 'approach' | 'crash'
}

// ─── Enemy: Alien Ship ───────────────────────────────────────────────────────
function spawnAlienShip(x, y, z) {
  const ship = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x40b860, roughness: 0.4, metalness: 0.5,
    emissive: 0x103a18, emissiveIntensity: 0.4,
  });
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0x80ffd0, roughness: 0.1, metalness: 0.4,
    transparent: true, opacity: 0.7, emissive: 0x40ffa0, emissiveIntensity: 0.6,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x202820, metalness: 0.8, roughness: 0.3,
  });

  // Saucer body (squashed sphere)
  const saucer = new THREE.Mesh(new THREE.SphereGeometry(0.9, 18, 12), hullMat);
  saucer.scale.set(1, 0.3, 1);
  ship.add(saucer);
  // Lower hemisphere trim
  const trim = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.07, 8, 24), trimMat);
  trim.rotation.x = Math.PI / 2;
  ship.add(trim);
  // Dome (cockpit)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10, 0, Math.PI*2, 0, Math.PI/2), domeMat);
  dome.position.y = 0.15;
  ship.add(dome);
  // Underside blinking lights (4 around)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xff4080 })
    );
    light.position.set(Math.cos(a) * 0.7, -0.18, Math.sin(a) * 0.7);
    light.userData.blinkPhase = Math.random() * Math.PI * 2;
    ship.add(light);
    ship.userData.lights = ship.userData.lights || [];
    ship.userData.lights.push(light);
  }
  // Underside cannon
  const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.35, 6), trimMat);
  gun.position.set(0, -0.3, 0);
  ship.add(gun);

  ship.position.set(x, y, z);
  ship.userData.health = diff().catHealth + 20;
  ship.userData.speed = 4.5 + Math.random() * 2.0;   // closes distance fast
  ship.userData.attackTimer = 0.8 + Math.random() * 1.2;
  ship.userData.bobOffset = Math.random() * Math.PI * 2;
  ship.userData.driftPhase = Math.random() * Math.PI * 2;
  ship.userData.isAlienShip = true;
  ship.userData.hitOffsetY = 0;
  ship.userData.hitRadius = 1.0;

  scene.add(ship);
  ENEMIES.push(ship);
  return ship;
}

// ─── Pluto Surface: Icy plain with cracks ────────────────────────────────────
const PLUTO_CRACKS = [];   // array of {x, z, halfW, halfL, angle}

function buildPlutoSurface() {
  // Ice ground — pale blue, bumpy
  const groundGeo = new THREE.PlaneGeometry(70, 70, 60, 60);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xd8e8f0, roughness: 0.4, metalness: 0.1,
    emissive: 0x4060a0, emissiveIntensity: 0.15,
  });
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i,
      Math.sin(x * 0.5) * 0.18 +
      Math.cos(y * 0.45) * 0.16 +
      (Math.random() - 0.5) * 0.1
    );
  }
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Scattered ice rocks
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xa8c0d4, roughness: 0.5, metalness: 0.2 });
  for (let i = 0; i < 14; i++) {
    const r = 0.4 + Math.random() * 1.2;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), rockMat);
    let rx, rz;
    do {
      rx = (Math.random() - 0.5) * 40;
      rz = (Math.random() - 0.5) * 40;
    } while (rx*rx + rz*rz < 10);
    rock.position.set(rx, r * 0.4, rz);
    rock.rotation.set(Math.random(), Math.random(), Math.random());
    rock.castShadow = true;
    scene.add(rock);
  }

  // ── Cracks (death/damage hazards) ──
  PLUTO_CRACKS.length = 0;
  const crackMat = new THREE.MeshBasicMaterial({
    color: 0x05101a, transparent: true, opacity: 0.95,
  });
  const innerCrackMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 1.0,
  });
  // Predefined cracks placed across the plain
  const crackDefs = [
    { x:  6, z:  4,  halfW: 0.7, halfL: 4.0, angle:  0.3 },
    { x: -8, z: -3,  halfW: 0.8, halfL: 5.0, angle: -0.6 },
    { x:  3, z: -10, halfW: 0.6, halfL: 3.5, angle:  1.1 },
    { x:-12, z:  9,  halfW: 0.9, halfL: 4.5, angle:  0.2 },
    { x: 11, z: -8,  halfW: 0.7, halfL: 3.8, angle: -1.2 },
    { x:  0, z: 13,  halfW: 1.0, halfL: 5.5, angle:  0.0 },
    { x:-15, z: -12, halfW: 0.6, halfL: 3.0, angle:  0.8 },
  ];
  for (const c of crackDefs) {
    // Outer dark crack
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(c.halfW * 2, c.halfL * 2),
      crackMat
    );
    outer.rotation.x = -Math.PI / 2;
    outer.rotation.z = c.angle;
    outer.position.set(c.x, 0.02, c.z);
    scene.add(outer);
    // Inner black abyss
    const inner = new THREE.Mesh(
      new THREE.PlaneGeometry(c.halfW * 1.2, c.halfL * 1.7),
      innerCrackMat
    );
    inner.rotation.x = -Math.PI / 2;
    inner.rotation.z = c.angle;
    inner.position.set(c.x, 0.03, c.z);
    scene.add(inner);
    // Faint blue glow from below (eerie)
    const glow = new THREE.PointLight(0x4080ff, 0.6, 4, 2);
    glow.position.set(c.x, -0.5, c.z);
    scene.add(glow);
    PLUTO_CRACKS.push(c);
  }

  // ── Dark sky dome with stars ──
  const skyGeo = new THREE.SphereGeometry(80, 24, 16);
  const skyMat = new THREE.MeshBasicMaterial({ color: 0x020414, side: THREE.BackSide, fog: false });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  // Stars sprinkled in the sky
  const starGeo = new THREE.BufferGeometry();
  const STAR_COUNT = 400;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Random point on upper hemisphere, radius ~75
    const u = Math.random();
    const v = Math.random() * 0.5;  // upper half
    const theta = u * Math.PI * 2;
    const phi = Math.acos(2 * v - 1);
    const r = 75;
    starPos[i*3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    starPos[i*3 + 1] = r * Math.cos(phi);
    starPos[i*3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.4, sizeAttenuation: true, fog: false })
  );
  scene.add(stars);

  // Distant Sun (small bright point — Pluto is far)
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xfff4e0, fog: false })
  );
  sun.position.set(30, 18, -50);
  scene.add(sun);
  const sunGlow = new THREE.PointLight(0xfff4e0, 0.8, 60, 1);
  sunGlow.position.copy(sun.position);
  scene.add(sunGlow);

  // Charon hovers larger than the moon back home
  const charon = new THREE.Mesh(
    new THREE.SphereGeometry(5, 32, 22),
    new THREE.MeshStandardMaterial({ color: 0x8a8898, roughness: 0.95, emissive: 0x1a1a2a, emissiveIntensity: 0.5 })
  );
  charon.position.set(-25, 20, -40);
  scene.add(charon);

  // The crashed cockpit wreckage (visual continuity from previous level)
  const wreck = new THREE.Group();
  const wreckMat = new THREE.MeshStandardMaterial({ color: 0x303840, roughness: 0.6, metalness: 0.5 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(3.5, 1.5, 5), wreckMat);
  hull.position.set(0, 0.4, 15);
  hull.rotation.set(0.2, 0.3, 0.15);
  wreck.add(hull);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2, 6), wreckMat);
  fin.position.set(1.2, 1.6, 16);
  fin.rotation.z = 0.6;
  wreck.add(fin);
  // Burn marks behind the wreck (trail of impact)
  const burnMat = new THREE.MeshBasicMaterial({ color: 0x202830, transparent: true, opacity: 0.7 });
  const burn = new THREE.Mesh(new THREE.PlaneGeometry(6, 14), burnMat);
  burn.rotation.x = -Math.PI / 2;
  burn.position.set(0, 0.04, 18);
  scene.add(burn);
  scene.add(wreck);

  // Lighting — cold dim
  const amb = new THREE.AmbientLight(0x6080a0, 0.9);
  scene.add(amb);
  scene.userData.ambient = amb;
  const sunLight = new THREE.DirectionalLight(0xfff0d8, 0.6);
  sunLight.position.set(30, 25, -50);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.setScalar(1024);
  scene.add(sunLight);
  const hemi = new THREE.HemisphereLight(0xc0d8ff, 0x405880, 0.6);
  scene.add(hemi);
}

// Test if a position is inside any crack rectangle (in local crack frame)
function isInCrack(x, z) {
  for (const c of PLUTO_CRACKS) {
    const cosA = Math.cos(-c.angle), sinA = Math.sin(-c.angle);
    const lx = (x - c.x) * cosA - (z - c.z) * sinA;
    const lz = (x - c.x) * sinA + (z - c.z) * cosA;
    if (Math.abs(lx) < c.halfW * 0.85 && Math.abs(lz) < c.halfL * 0.85) {
      return c;
    }
  }
  return null;
}

// ─── Enemy: Three-Headed Tentacle Martian ────────────────────────────────────
function spawnMartian(x, z) {
  const m = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xa040c0, roughness: 0.7,
    emissive: 0x4a1060, emissiveIntensity: 0.4,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xd060e0, roughness: 0.6,
    emissive: 0x70208a, emissiveIntensity: 0.5,
  });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffff60 });
  const mouthMat = new THREE.MeshBasicMaterial({ color: 0x1a0010 });
  const tentMat = new THREE.MeshStandardMaterial({
    color: 0x8030a0, roughness: 0.8,
    emissive: 0x401050, emissiveIntensity: 0.3,
  });

  // Bulbous body
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.7, 14, 11), bodyMat);
  body.scale.set(1, 1.1, 1);
  body.position.y = 1.0;
  m.add(body);

  // Body slime spots
  for (let i = 0; i < 6; i++) {
    const spot = new THREE.Mesh(
      new THREE.SphereGeometry(0.1 + Math.random() * 0.08, 6, 5),
      new THREE.MeshStandardMaterial({ color: 0x602080, roughness: 0.4, emissive: 0x301040 })
    );
    const a = Math.random() * Math.PI * 2;
    spot.position.set(Math.cos(a) * 0.65, 0.7 + Math.random() * 0.8, Math.sin(a) * 0.65);
    m.add(spot);
  }

  // ── 3 heads in a triangle on top ──
  const headPositions = [
    [0,     1.95,  0.25],
    [-0.32, 1.95, -0.18],
    [0.32,  1.95, -0.18],
  ];
  m.userData.heads = [];
  for (const [hx, hy, hz] of headPositions) {
    const head = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), headMat);
    head.add(ball);
    // Big yellow eye
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), eyeMat);
    eye.position.set(0, 0.04, 0.28);
    head.add(eye);
    // Pupil
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), mouthMat);
    pupil.position.set(0, 0.04, 0.36);
    head.add(pupil);
    // Tiny mouth
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), mouthMat);
    mouth.scale.set(1.2, 0.6, 0.6);
    mouth.position.set(0, -0.15, 0.28);
    head.add(mouth);
    // Eye glow
    const glow = new THREE.PointLight(0xffff60, 0.5, 1.8, 2);
    glow.position.set(0, 0.04, 0.3);
    head.add(glow);

    head.position.set(hx, hy, hz);
    head.userData.bobPhase = Math.random() * Math.PI * 2;
    head.userData.baseY = hy;
    m.add(head);
    m.userData.heads.push(head);
  }

  // ── Tentacles ──
  m.userData.tentacles = [];
  const numTents = 6;
  for (let i = 0; i < numTents; i++) {
    const ang = (i / numTents) * Math.PI * 2;
    const segs = 5;
    const tent = new THREE.Group();
    for (let s = 0; s < segs; s++) {
      const seg = new THREE.Mesh(
        new THREE.SphereGeometry(0.12 - s * 0.015, 8, 6),
        tentMat
      );
      seg.position.y = 0.7 - s * 0.18;
      seg.userData.baseY = seg.position.y;
      tent.add(seg);
    }
    tent.position.set(Math.cos(ang) * 0.55, 0.35, Math.sin(ang) * 0.55);
    tent.userData.angle = ang;
    tent.userData.phase = Math.random() * Math.PI * 2;
    m.add(tent);
    m.userData.tentacles.push(tent);
  }

  m.position.set(x, 0, z);
  m.userData.health = diff().catHealth + 30;
  m.userData.speed = 1.6 + Math.random() * 0.6;
  m.userData.attackTimer = Math.random() * 2;
  m.userData.bobOffset = Math.random() * Math.PI * 2;
  m.userData.isMartian = true;
  m.userData.hitOffsetY = 1.2;     // center of bulbous body
  m.userData.hitRadius = 1.05;

  scene.add(m);
  ENEMIES.push(m);
  return m;
}

// ─── Rocketship (Pluto exit) ─────────────────────────────────────────────────
function buildPlutoRocketship() {
  const rocket = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xe8e8f0, roughness: 0.4, metalness: 0.5 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xc04040, roughness: 0.5, metalness: 0.4 });
  const winMat  = new THREE.MeshStandardMaterial({
    color: 0x60c8ff, emissive: 0x40a0e0, emissiveIntensity: 0.8,
    metalness: 0.6, roughness: 0.2,
  });
  const fireMat = new THREE.MeshBasicMaterial({ color: 0xff6020 });

  // Body
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 6.0, 18), hullMat);
  body.position.y = 3.0;
  body.castShadow = true;
  rocket.add(body);

  // Red trim band
  const trim = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.02, 0.3, 18), trimMat);
  trim.position.y = 4.5;
  rocket.add(trim);

  // Nose cone
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 18), trimMat);
  nose.position.y = 7.1;
  rocket.add(nose);

  // Porthole window (looks invitingly bright)
  const window = new THREE.Mesh(new THREE.CircleGeometry(0.35, 20), winMat);
  window.position.set(0, 4.4, 1.05);
  rocket.add(window);
  const winFrame = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.05, 8, 20), trimMat);
  winFrame.rotation.y = Math.PI / 2;
  winFrame.position.set(0, 4.4, 1.06);
  winFrame.rotation.x = Math.PI / 2;
  rocket.add(winFrame);

  // Fins
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.8, 1.2), trimMat);
    fin.position.set(Math.cos(ang) * 1.1, 1.0, Math.sin(ang) * 1.1);
    fin.rotation.y = ang;
    rocket.add(fin);
  }

  // Engine bell
  const bell = new THREE.Mesh(
    new THREE.CylinderGeometry(1.0, 1.4, 0.6, 18),
    new THREE.MeshStandardMaterial({ color: 0x40444a, metalness: 0.8, roughness: 0.3 })
  );
  bell.position.y = 0.3;
  rocket.add(bell);

  // Idle flame underneath (visible glow even before takeoff)
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 12), fireMat);
  flame.rotation.x = Math.PI;
  flame.position.y = -0.6;
  rocket.add(flame);
  rocket.userData.flame = flame;

  // Door highlight (pulsing ring at entry zone)
  const door = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.7, 24),
    new THREE.MeshBasicMaterial({ color: 0x66ffd0, side: THREE.DoubleSide, transparent: true, opacity: 0.7 })
  );
  door.position.set(0, 2.8, 1.05);
  rocket.add(door);
  rocket.userData.door = door;

  // Glow lights
  const glow = new THREE.PointLight(0xff8040, 2.2, 8, 2);
  glow.position.y = -0.6;
  rocket.add(glow);
  rocket.userData.glow = glow;

  rocket.position.set(0, 0, 0);
  scene.add(rocket);
  scene.userData.rocket = rocket;
}

// ─── Neptune approach (boss fight cockpit) ───────────────────────────────────
function buildNeptuneApproach() {
  // Identical cockpit shell as the space-cockpit ride, but Neptune ahead instead of Pluto
  buildSpaceCockpit();   // sets up cockpit + star field + radar/dash + lighting

  // Replace Pluto with Neptune (deep blue, larger, with banding via emissive)
  const pluto = scene.userData.pluto;
  if (pluto) {
    pluto.material.color.setHex(0x2a4ea8);
    pluto.material.emissive.setHex(0x102050);
    pluto.material.emissiveIntensity = 0.6;
    pluto.material.needsUpdate = true;
    // Add storm spot to suggest the Great Dark Spot
    const spot = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 24),
      new THREE.MeshBasicMaterial({ color: 0x101a3a, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    spot.position.set(0.5, 0.3, 4.05);   // on the surface facing camera
    pluto.add(spot);
  }
  // Hide Pluto's little Charon
  if (scene.userData.charon) scene.userData.charon.visible = false;

  // Reset progress meaning: 'fight' (boss alive) → 'approach' (post-kill landing) → 'crash' (=landing complete)
  scene.userData.spacePhase = 'fight';
  scene.userData.spaceTarget = 'neptune';
}

// ─── Boss: huge alien mothership with red weak point ─────────────────────────
function spawnAlienBoss() {
  const boss = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x508060, roughness: 0.5, metalness: 0.6,
    emissive: 0x1a3a20, emissiveIntensity: 0.4,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x202828, metalness: 0.8, roughness: 0.3,
  });
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0x80ffd0, roughness: 0.1, metalness: 0.4,
    transparent: true, opacity: 0.6, emissive: 0x40ffa0, emissiveIntensity: 0.5,
  });

  // Massive saucer
  const SAUCER_R = 4.5;
  const saucer = new THREE.Mesh(new THREE.SphereGeometry(SAUCER_R, 28, 16), hullMat);
  saucer.scale.set(1, 0.28, 1);
  boss.add(saucer);

  // Lower rim trim
  const rim = new THREE.Mesh(new THREE.TorusGeometry(SAUCER_R, 0.25, 10, 36), trimMat);
  rim.rotation.x = Math.PI / 2;
  boss.add(rim);

  // Top dome
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(2.0, 22, 14, 0, Math.PI*2, 0, Math.PI/2),
    domeMat
  );
  dome.position.y = 0.6;
  boss.add(dome);

  // Underside blinker pods around the rim
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const pod = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4080 })
    );
    pod.position.set(Math.cos(a) * SAUCER_R * 0.92, -0.45, Math.sin(a) * SAUCER_R * 0.92);
    pod.userData.blinkPhase = Math.random() * Math.PI * 2;
    boss.add(pod);
    boss.userData.lights = boss.userData.lights || [];
    boss.userData.lights.push(pod);
  }

  // Cannon turrets (4 around the rim, lower side)
  boss.userData.cannons = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const turret = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.4, 0.3, 12),
      trimMat
    );
    turret.add(base);
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.18, 1.6, 10),
      trimMat
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, -0.7);
    turret.add(barrel);
    // Tip glow
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4060 })
    );
    tip.position.set(0, 0, -1.4);
    turret.add(tip);
    turret.userData.tip = tip;
    turret.position.set(Math.cos(a) * SAUCER_R * 0.7, -0.5, Math.sin(a) * SAUCER_R * 0.7);
    turret.rotation.y = -a + Math.PI;
    turret.userData.fireOffset = (i / 4) * 1.0;
    boss.add(turret);
    boss.userData.cannons.push(turret);
  }

  // ── Red glowing weak point in the middle (the target) ──
  // Big and obvious — clearly visible from cockpit distance.
  const WEAK_R = 2.4;
  const weakMat = new THREE.MeshBasicMaterial({ color: 0xff2030 });
  const weak = new THREE.Mesh(new THREE.SphereGeometry(WEAK_R, 24, 18), weakMat);
  weak.position.set(0, 0, 0);
  boss.add(weak);
  // Inner pulsing core (brighter)
  const weakCore = new THREE.Mesh(
    new THREE.SphereGeometry(WEAK_R * 0.55, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0xffe060 })
  );
  weakCore.position.copy(weak.position);
  boss.add(weakCore);
  // Equatorial halo ring (lying in the saucer's mid-plane, very visible from any angle)
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(WEAK_R * 1.1, WEAK_R * 1.55, 48),
    new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  halo.position.copy(weak.position);
  halo.rotation.x = -Math.PI / 2;
  boss.add(halo);

  // Bright point light at weak point so it glows the underbelly
  const weakLight = new THREE.PointLight(0xff4040, 3.5, 8, 2);
  weakLight.position.copy(weak.position);
  boss.add(weakLight);

  boss.userData.weakPoint = weak;
  boss.userData.weakCore = weakCore;
  boss.userData.weakHalo = halo;
  boss.userData.weakLight = weakLight;
  boss.userData.weakRadius = WEAK_R * 0.8;    // tighter than the visible sphere — requires aim

  // Big HP + flags
  boss.position.set(0, 1, -28);
  boss.userData.health = 480;
  boss.userData.maxHealth = 480;
  boss.userData.speed = 0;          // stays at distance, doesn't ram
  boss.userData.attackTimer = 1.5;
  boss.userData.bobOffset = Math.random() * Math.PI * 2;
  boss.userData.driftPhase = Math.random() * Math.PI * 2;
  boss.userData.isBoss = true;
  boss.userData.hitOffsetY = 0;
  boss.userData.hitRadius = SAUCER_R;

  scene.add(boss);
  ENEMIES.push(boss);
  scene.userData.boss = boss;
  return boss;
}

// ─── Neptune Surface: ruined ancient city ───────────────────────────────────
function buildNeptuneSurface() {
  // Cracked stone ground (ancient plaza tiles)
  const groundGeo = new THREE.PlaneGeometry(70, 70, 50, 50);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x3a3850, roughness: 0.85, metalness: 0.1,
    emissive: 0x101225, emissiveIntensity: 0.3,
  });
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, (Math.random() - 0.5) * 0.08);
  }
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Plaza tile grid (decorative lines)
  const tileLineMat = new THREE.MeshBasicMaterial({ color: 0x1a1a30, transparent: true, opacity: 0.45 });
  for (let i = -25; i <= 25; i += 5) {
    const lineZ = new THREE.Mesh(new THREE.PlaneGeometry(55, 0.06), tileLineMat);
    lineZ.rotation.x = -Math.PI / 2;
    lineZ.position.set(0, 0.02, i);
    scene.add(lineZ);
    const lineX = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 55), tileLineMat);
    lineX.rotation.x = -Math.PI / 2;
    lineX.position.set(i, 0.02, 0);
    scene.add(lineX);
  }

  // ── Broken columns scattered around the plaza ──
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6a6890, roughness: 0.8, metalness: 0.15 });
  const stoneDarkMat = new THREE.MeshStandardMaterial({ color: 0x4a4878, roughness: 0.85 });
  const colPositions = [
    [-8, -6, 4.5], [8, -6, 3.2], [-8, 6, 5.0], [8, 6, 2.5],
    [-14, 0, 3.8], [14, 0, 4.2], [0, -14, 4.5], [0, 14, 1.4],
    [-5, 10, 5.5], [10, -10, 4.0], [-12, -12, 1.8],
  ];
  for (const [cx, cz, h] of colPositions) {
    // Square base
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 1.2), stoneDarkMat);
    base.position.set(cx, 0.15, cz);
    base.castShadow = true;
    scene.add(base);
    // Fluted column (slightly tilted, broken at the top)
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, h, 14), stoneMat);
    col.position.set(cx, 0.3 + h / 2, cz);
    col.rotation.z = (Math.random() - 0.5) * 0.18;
    col.rotation.x = (Math.random() - 0.5) * 0.12;
    col.castShadow = true;
    col.receiveShadow = true;
    scene.add(col);
    // Capital fragment on top (some still have, some don't)
    if (Math.random() > 0.4) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.9), stoneDarkMat);
      cap.position.set(cx, 0.3 + h + 0.12, cz);
      cap.rotation.y = Math.random() * Math.PI;
      scene.add(cap);
    }
    // Fallen column drum next to base
    if (Math.random() > 0.3) {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.0, 12), stoneMat);
      drum.rotation.z = Math.PI / 2;
      drum.position.set(cx + (Math.random() - 0.5) * 2, 0.4, cz + (Math.random() - 0.5) * 2);
      scene.add(drum);
    }
  }

  // ── Crumbled wall segments ──
  for (let i = 0; i < 8; i++) {
    const wallH = 1.5 + Math.random() * 1.8;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(3 + Math.random() * 2, wallH, 0.5), stoneMat);
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const r = 16 + Math.random() * 3;
    wall.position.set(Math.cos(a) * r, wallH / 2, Math.sin(a) * r);
    wall.rotation.y = -a + Math.PI / 2 + (Math.random() - 0.5) * 0.3;
    wall.rotation.z = (Math.random() - 0.5) * 0.15;
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
    // Rubble pile at base
    for (let k = 0; k < 3; k++) {
      const rubble = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.25 + Math.random() * 0.2, 0),
        stoneDarkMat
      );
      rubble.position.set(
        wall.position.x + (Math.random() - 0.5) * 1.5,
        0.15,
        wall.position.z + (Math.random() - 0.5) * 1.5,
      );
      rubble.rotation.set(Math.random(), Math.random(), Math.random());
      scene.add(rubble);
    }
  }

  // ── Toppled alien statue (the centerpiece) ──
  const statue = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.0, 2.5, 12), stoneMat);
  torso.rotation.z = Math.PI / 2 - 0.2;
  torso.position.set(-2, 0.7, -3);
  statue.add(torso);
  // Severed head lying nearby
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.7, 14, 10), stoneMat);
  head.position.set(-4.5, 0.65, -4.2);
  statue.add(head);
  // Three eye sockets (matches the martians — same civilization?)
  for (const [dx, dy] of [[-0.25, 0.1], [0.0, 0.25], [0.25, 0.1]]) {
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    eye.position.set(-4.5 + dx, 0.65 + dy, -3.6);
    statue.add(eye);
  }
  scene.add(statue);

  // ── Distant ruined skyline ──
  const skylineMat = new THREE.MeshBasicMaterial({ color: 0x1a1a35, fog: true });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = 35;
    const h = 4 + Math.random() * 8;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(2 + Math.random() * 2, h, 2 + Math.random() * 2), skylineMat);
    tower.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
    tower.rotation.y = Math.random() * 0.3;
    scene.add(tower);
  }

  // ── Storm sky dome ──
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(70, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x1a2a5a, side: THREE.BackSide, fog: false })
  );
  scene.add(sky);

  // Lightning-flash placeholder light (flickers)
  const flash = new THREE.PointLight(0xa0c0ff, 0.4, 60, 1);
  flash.position.set(0, 30, 0);
  scene.add(flash);
  scene.userData.neptuneFlash = flash;

  // ── Lighting ──
  const amb = new THREE.AmbientLight(0x6080c0, 1.0);
  scene.add(amb);
  scene.userData.ambient = amb;
  const hemi = new THREE.HemisphereLight(0x8090d0, 0x1a1a30, 0.8);
  scene.add(hemi);
  const moonLight = new THREE.DirectionalLight(0xbfd8ff, 0.7);
  moonLight.position.set(15, 25, -10);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.setScalar(1024);
  scene.add(moonLight);
}

// ─── Enemy: Evil Vacuum ──────────────────────────────────────────────────────
function spawnVacuum(x, z) {
  const v = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xa83030, roughness: 0.55, metalness: 0.4 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.3 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xc0c0d0, metalness: 0.9, roughness: 0.2 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2010 });

  // Lower suction head (wide flat base)
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.25, 14), trimMat);
  head.position.y = 0.15;
  v.add(head);
  // Suction mouth (dark circle on top of head)
  const mouth = new THREE.Mesh(
    new THREE.CircleGeometry(0.6, 18),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  );
  mouth.rotation.x = -Math.PI / 2;
  mouth.position.y = 0.28;
  v.add(mouth);

  // Main canister body (upright cylinder)
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.6, 14), bodyMat);
  body.position.y = 1.15;
  v.add(body);

  // Trim bands
  for (const by of [0.55, 1.2, 1.75]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.05, 8, 18), trimMat);
    band.rotation.x = Math.PI / 2;
    band.position.y = by;
    v.add(band);
  }

  // Handle on top
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.05, 8, 16, Math.PI), chromeMat);
  handle.rotation.x = Math.PI / 2;
  handle.position.y = 2.05;
  v.add(handle);

  // Hose (curving from body to head, made of stacked rings)
  for (let i = 0; i < 8; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.04, 6, 10), trimMat);
    const tt = i / 7;
    // Approximate an S-curve from body side (x=0.45, y=1.5) to head side (x=0.5, y=0.3)
    const xx = 0.45 + Math.sin(tt * Math.PI) * 0.25;
    const yy = 1.5 - tt * 1.2;
    ring.position.set(xx, yy, 0);
    ring.rotation.x = Math.PI / 2;
    ring.rotation.z = Math.cos(tt * Math.PI) * 0.3;
    v.add(ring);
  }

  // ── The terrifying glowing red EYE ──
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), eyeMat);
  eye.position.set(0, 1.5, 0.42);
  v.add(eye);
  const eyeRing = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.04, 8, 16), trimMat);
  eyeRing.rotation.y = Math.PI / 2;
  eyeRing.position.copy(eye.position);
  v.add(eyeRing);
  // Eye glow
  const eyeLight = new THREE.PointLight(0xff2010, 1.4, 4, 2);
  eyeLight.position.copy(eye.position);
  v.add(eyeLight);
  v.userData.eyeLight = eyeLight;

  // Cord trailing behind
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), trimMat);
  cord.position.set(-0.5, 0.5, -0.5);
  cord.rotation.z = 0.7;
  cord.rotation.x = 0.3;
  v.add(cord);

  // Wheels
  for (const [sx, sz] of [[-0.45, 0.45], [0.45, 0.45], [-0.45, -0.45], [0.45, -0.45]]) {
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.06, 6, 14), trimMat);
    wheel.rotation.y = Math.PI / 2;
    wheel.position.set(sx, 0.12, sz);
    v.add(wheel);
  }

  // Wispy suction effect (visible cones above the mouth)
  const suction = new THREE.Mesh(
    new THREE.ConeGeometry(0.65, 0.8, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8090a0, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  suction.position.y = 0.7;
  v.add(suction);
  v.userData.suction = suction;

  v.position.set(x, 0, z);
  v.userData.health = diff().catHealth + 10;
  v.userData.speed = 1.9 + Math.random() * 0.7;
  v.userData.attackTimer = Math.random() * 2;
  v.userData.bobOffset = Math.random() * Math.PI * 2;
  v.userData.isVacuum = true;
  v.userData.hitOffsetY = 1.1;
  v.userData.hitRadius = 0.85;

  scene.add(v);
  ENEMIES.push(v);
  return v;
}

// ─── Dirt Clod (Neptune ammo) ───────────────────────────────────────────────
const dirtMat = persistMat(new THREE.MeshStandardMaterial({
  color: 0x5a3a20, roughness: 1.0, metalness: 0,
  emissive: 0x1a0a05, emissiveIntensity: 0.2,
}));

function makeDirtClod(scale = 1) {
  // Lumpy potato shape via slightly deformed icosahedron
  const geo = new THREE.IcosahedronGeometry(0.18 * scale, 0);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) * (0.85 + Math.random() * 0.35),
      p.getY(i) * (0.85 + Math.random() * 0.35),
      p.getZ(i) * (0.85 + Math.random() * 0.35),
    );
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, dirtMat);
}

function throwDirt() {
  if (STATE.dirt <= 0 || STATE.gameover) return;
  STATE.dirt--;
  updateHUD();

  const clod = makeDirtClod();
  clod.position.copy(camera.position);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  clod.userData.velocity = dir.multiplyScalar(18);
  clod.userData.lifetime = 3;
  clod.userData.damage = 30;
  scene.add(clod);
  PROJECTILES.push(clod);
  animateThrow();
}

function swapHeldToDirt() {
  if (!dogArm || !dogBoneHeld) return;
  dogArm.remove(dogBoneHeld);
  const clod = makeDirtClod(1.4);
  clod.position.set(0.05, -0.1, 0);
  dogArm.add(clod);
  dogBoneHeld = clod;
}

// ─── Dirt pile pickups (Neptune ammo) ────────────────────────────────────────
function spawnDirtPickups(count) {
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group();
    // A small mound of 4-6 lumpy clods piled together
    const lumpCount = 4 + Math.floor(Math.random() * 3);
    for (let k = 0; k < lumpCount; k++) {
      const lump = makeDirtClod(1.2 + Math.random() * 0.4);
      lump.position.set(
        (Math.random() - 0.5) * 0.4,
        Math.random() * 0.18,
        (Math.random() - 0.5) * 0.4,
      );
      lump.rotation.set(Math.random(), Math.random(), Math.random());
      g.add(lump);
    }
    // Subtle brown glow so they're spottable
    const glow = new THREE.PointLight(0xc88a40, 0.6, 2, 2);
    glow.position.y = 0.2;
    g.add(glow);

    let px, pz;
    do {
      px = (Math.random() - 0.5) * 36;
      pz = (Math.random() - 0.5) * 36;
    } while (px*px + pz*pz < 6);
    g.position.set(px, 0.1, pz);
    g.userData.rotOffset = Math.random() * Math.PI * 2;
    scene.add(g);
    DIRT_PICKUPS.push(g);
  }
}

function updateDirtPickups(dt) {
  const t = clock.getElapsedTime();
  for (let i = DIRT_PICKUPS.length - 1; i >= 0; i--) {
    const d = DIRT_PICKUPS[i];
    d.rotation.y += dt * 0.4;
    // Pickup
    const dx = d.position.x - camera.position.x;
    const dz = d.position.z - camera.position.z;
    if (Math.sqrt(dx*dx + dz*dz) < 0.9) {
      const grab = 4;
      STATE.dirt = Math.min(STATE.dirt + grab, 40);
      updateHUD();
      showMessage(`+${grab} DIRT CLODS!`, 1100);
      scene.remove(d);
      DIRT_PICKUPS.splice(i, 1);
    }
  }
}

// ─── UFO kidnap cinematic (Neptune → Uranus) ─────────────────────────────────
function triggerKidnap() {
  transitioning = true;
  document.exitPointerLock();

  // Build a UFO above the player and a tractor beam down to them
  const ufo = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x90c0d0, metalness: 0.7, roughness: 0.25, emissive: 0x2050a0, emissiveIntensity: 0.4 });
  const domeMat = new THREE.MeshStandardMaterial({ color: 0x80ffe0, transparent: true, opacity: 0.6, emissive: 0x40ffa0, emissiveIntensity: 0.6 });
  const saucer = new THREE.Mesh(new THREE.SphereGeometry(3.5, 24, 14), hullMat);
  saucer.scale.set(1, 0.3, 1);
  ufo.add(saucer);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 18, 12, 0, Math.PI*2, 0, Math.PI/2),
    domeMat
  );
  dome.position.y = 0.5;
  ufo.add(dome);
  // Underside blinking lights
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 6),
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff40c0 : 0x40c0ff })
    );
    light.position.set(Math.cos(a) * 3.0, -0.35, Math.sin(a) * 3.0);
    ufo.add(light);
  }
  // Tractor beam: a wide cone hanging below, transparent green
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(2.5, 18, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x80ffa0, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  beam.position.y = -9.5;
  beam.rotation.x = Math.PI;
  ufo.add(beam);
  // Strong green point light at the base
  const beamGlow = new THREE.PointLight(0x80ffa0, 4.5, 24, 1.5);
  beamGlow.position.set(0, -10, 0);
  ufo.add(beamGlow);

  ufo.position.set(camera.position.x, 50, camera.position.z);
  scene.add(ufo);
  scene.userData.ufo = ufo;

  showMessage('🛸 ABDUCTED! THE ALIENS WANT YOU! 🛸', 4000);

  // Animate: UFO descends, then camera lifts up into it
  const start = performance.now();
  const totalMs = 3200;
  const animate = () => {
    const now = performance.now();
    const tt = Math.min(1, (now - start) / totalMs);
    // Phase 1 (0..0.45): UFO descends from y=50 to y=12 above player
    const ufoY = 50 - smoothstep(0, 0.45, tt) * 38;
    ufo.position.y = ufoY;
    // Phase 2 (0.45..1.0): player rises into the UFO (camera y up)
    const liftStart = PLAYER_HEIGHT;
    const liftEnd = 11.0;
    const liftT = smoothstep(0.45, 1.0, tt);
    camera.position.y = liftStart + (liftEnd - liftStart) * liftT;
    // Player slowly rotates in the beam
    playerYaw += 0.025;
    camera.rotation.y = playerYaw;
    // Beam pulses brighter as it engages
    beam.material.opacity = 0.25 + 0.4 * Math.abs(Math.sin(tt * 18));
    beamGlow.intensity = 3.0 + 4.0 * Math.abs(Math.sin(tt * 18));
    if (tt < 1) requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);

  // Fade to black, then load Uranus
  const overlay = document.getElementById('transition-overlay');
  overlay.style.background = '#88ffc0';   // green tractor flash
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.opacity = '1'; }, totalMs - 700);
  setTimeout(() => {
    overlay.style.background = '#000';
    transitioning = false;
    loadNextRoom();   // → room 11 = uranus-surface
  }, totalMs + 600);
}

function smoothstep(a, b, t) {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

// ─── Uranus Surface: alien outpost under the rings ───────────────────────────
function buildUranusSurface() {
  // Pale cyan rocky ground with gentle bumps
  const groundGeo = new THREE.PlaneGeometry(70, 70, 50, 50);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x90d8d8, roughness: 0.75, metalness: 0.15,
    emissive: 0x205858, emissiveIntensity: 0.25,
  });
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, Math.sin(x * 0.3) * 0.12 + Math.cos(y * 0.25) * 0.12 + (Math.random() - 0.5) * 0.08);
  }
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Frozen methane "puddles" — pale shimmering patches
  const puddleMat = new THREE.MeshStandardMaterial({
    color: 0xc8ffff, roughness: 0.25, metalness: 0.6,
    emissive: 0x408080, emissiveIntensity: 0.5,
  });
  for (let i = 0; i < 9; i++) {
    const puddle = new THREE.Mesh(new THREE.CircleGeometry(1 + Math.random() * 1.5, 14), puddleMat);
    puddle.rotation.x = -Math.PI / 2;
    puddle.position.set((Math.random() - 0.5) * 38, 0.02, (Math.random() - 0.5) * 38);
    scene.add(puddle);
  }

  // ── Alien crystal pylons (glowing teal spires) ──
  const crystalMat = new THREE.MeshStandardMaterial({
    color: 0x60ffe0, roughness: 0.15, metalness: 0.3,
    emissive: 0x40c8c0, emissiveIntensity: 1.0, transparent: true, opacity: 0.85,
  });
  for (let i = 0; i < 8; i++) {
    const h = 3.5 + Math.random() * 2.5;
    const crystal = new THREE.Mesh(new THREE.ConeGeometry(0.7, h, 6), crystalMat);
    const a = (i / 8) * Math.PI * 2 + Math.random() * 0.4;
    const r = 10 + Math.random() * 6;
    crystal.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
    crystal.rotation.y = Math.random() * Math.PI;
    crystal.castShadow = true;
    scene.add(crystal);
    // Glow point at base
    const glow = new THREE.PointLight(0x60ffe0, 1.0, 6, 2);
    glow.position.set(crystal.position.x, 0.6, crystal.position.z);
    scene.add(glow);
  }

  // ── Alien hexagonal outpost in the center ──
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x5a6a78, metalness: 0.7, roughness: 0.3 });
  const outpost = new THREE.Group();
  const baseRing = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.4, 0.6, 6), baseMat);
  baseRing.position.y = 0.3;
  outpost.add(baseRing);
  // Antenna mast
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 4, 8), baseMat);
  mast.position.y = 2.6;
  outpost.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI*2, 0, Math.PI/2), baseMat);
  dish.position.y = 4.5;
  dish.rotation.x = Math.PI;
  outpost.add(dish);
  // Top blinker
  const blink = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4060 }));
  blink.position.y = 4.85;
  outpost.add(blink);
  outpost.userData.blinker = blink;
  outpost.position.set(0, 0, -8);
  scene.add(outpost);
  scene.userData.outpost = outpost;

  // ── Uranus rings: vertical arc overhead (Uranus is tilted ~98°!) ──
  const ringInner = 35, ringOuter = 50;
  const ringsMat = new THREE.MeshBasicMaterial({
    color: 0xb0e0e8, transparent: true, opacity: 0.7,
    side: THREE.DoubleSide, fog: false,
  });
  // Uranus tilts ~98°, so its rings appear as a vertical band arcing across the sky.
  // RingGeometry sits in the XY plane by default — leave it standing upright,
  // just tilt slightly so it doesn't go straight up.
  const rings = new THREE.Mesh(new THREE.RingGeometry(ringInner, ringOuter, 96), ringsMat);
  rings.rotation.y = 0.25;            // a bit angled across the player's view
  rings.rotation.z = 0.18;             // small bank
  rings.position.set(0, 0, 0);
  scene.add(rings);
  // Inner darker band
  const ringsInnerBand = new THREE.Mesh(
    new THREE.RingGeometry(ringInner + 2, ringInner + 4, 96),
    new THREE.MeshBasicMaterial({ color: 0x6090a0, transparent: true, opacity: 0.45, side: THREE.DoubleSide, fog: false })
  );
  ringsInnerBand.rotation.copy(rings.rotation);
  scene.add(ringsInnerBand);
  // Brighter inner edge band
  const ringsHighlight = new THREE.Mesh(
    new THREE.RingGeometry(ringOuter - 1, ringOuter, 96),
    new THREE.MeshBasicMaterial({ color: 0xe0f8ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, fog: false })
  );
  ringsHighlight.rotation.copy(rings.rotation);
  scene.add(ringsHighlight);

  // ── Sky dome (pale teal-cyan, atmospheric) ──
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(80, 28, 18),
    new THREE.MeshBasicMaterial({ color: 0x4080a8, side: THREE.BackSide, fog: false })
  );
  scene.add(sky);

  // Distant moons (Miranda, Ariel, Umbriel as small pale dots)
  const moonMat = new THREE.MeshBasicMaterial({ color: 0xb0c8d8, fog: false });
  for (const [mx, my, mz, sc] of [[20, 22, -45, 1.4], [-25, 18, -50, 1.0], [40, 28, -30, 0.7]]) {
    const moon = new THREE.Mesh(new THREE.SphereGeometry(sc, 16, 12), moonMat);
    moon.position.set(mx, my, mz);
    scene.add(moon);
  }

  // Lighting (cold pale)
  const amb = new THREE.AmbientLight(0xc0e0e8, 1.1);
  scene.add(amb);
  scene.userData.ambient = amb;
  const sun = new THREE.DirectionalLight(0xe0f0ff, 0.6);
  sun.position.set(10, 25, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(1024);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xc0e8f0, 0x60a0a8, 0.8);
  scene.add(hemi);
}

// ─── Enemy: Gray Alien (Uranus) ──────────────────────────────────────────────
function spawnGrayAlien(x, z) {
  const a = new THREE.Group();

  const skinMat = new THREE.MeshStandardMaterial({ color: 0x9aa8a0, roughness: 0.6, metalness: 0.1, emissive: 0x202828, emissiveIntensity: 0.3 });
  const suitMat = new THREE.MeshStandardMaterial({ color: 0x3a4858, metalness: 0.5, roughness: 0.4 });
  const eyeMat  = new THREE.MeshBasicMaterial({ color: 0x000000 });

  // Skinny legs
  for (const sx of [-0.18, 0.18]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.9, 8), suitMat);
    leg.position.set(sx, 0.45, 0);
    a.add(leg);
  }

  // Torso (slim suit)
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.28, 0.95, 12), suitMat);
  torso.position.y = 1.4;
  a.add(torso);
  // Chest emblem
  const emblem = new THREE.Mesh(
    new THREE.CircleGeometry(0.12, 16),
    new THREE.MeshBasicMaterial({ color: 0x60ffe0 })
  );
  emblem.position.set(0, 1.45, 0.29);
  a.add(emblem);

  // Spindly arms
  for (const sx of [-0.36, 0.36]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.95, 8), skinMat);
    arm.position.set(sx, 1.35, 0);
    arm.rotation.z = sx > 0 ? -0.15 : 0.15;
    a.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), skinMat);
    hand.position.set(sx + (sx > 0 ? -0.05 : 0.05), 0.85, 0);
    a.add(hand);
  }

  // Long thin neck
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.25, 8), skinMat);
  neck.position.y = 2.0;
  a.add(neck);

  // Bulbous head (light bulb shape)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), skinMat);
  head.position.y = 2.32;
  head.scale.set(1.0, 1.1, 0.95);
  a.add(head);
  // Pointed chin
  const chin = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.25, 10), skinMat);
  chin.position.y = 2.05;
  chin.rotation.x = Math.PI;
  a.add(chin);

  // Big black almond eyes (the iconic look)
  for (const sx of [-0.13, 0.13]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), eyeMat);
    eye.scale.set(0.9, 1.4, 0.6);
    eye.position.set(sx, 2.32, 0.26);
    eye.rotation.z = sx > 0 ? -0.25 : 0.25;
    a.add(eye);
  }
  // Tiny slit mouth + nostrils
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.02), eyeMat);
  mouth.position.set(0, 2.13, 0.31);
  a.add(mouth);

  // Head halo glow
  const halo = new THREE.PointLight(0x80ffe0, 0.6, 2, 2);
  halo.position.y = 2.4;
  a.add(halo);
  a.userData.halo = halo;

  a.position.set(x, 0, z);
  a.userData.health = diff().catHealth + 20;
  a.userData.speed = 1.8 + Math.random() * 0.5;
  a.userData.attackTimer = 0.6 + Math.random() * 1.2;
  a.userData.bobOffset = Math.random() * Math.PI * 2;
  a.userData.isGrayAlien = true;
  a.userData.hitOffsetY = 1.5;
  a.userData.hitRadius = 0.85;

  scene.add(a);
  ENEMIES.push(a);
  return a;
}

// ─── Saturn Approach: rings dogfight ─────────────────────────────────────────
function buildSaturnApproach() {
  // Reuse the cockpit interior + stars + dash from the standard space-cockpit
  buildSpaceCockpit();

  // Re-skin the distant "Pluto" mesh into a giant Saturn with horizontal rings
  const planet = scene.userData.pluto;
  if (planet) {
    planet.material.color.setHex(0xe8c890);
    planet.material.emissive.setHex(0x5a3a18);
    planet.material.emissiveIntensity = 0.6;
    planet.material.roughness = 0.85;
    planet.material.needsUpdate = true;
    // Add atmospheric bands (lighter circles) on the visible face
    const bandColors = [0xfff0c0, 0xd8b070, 0xc8a060];
    for (let i = 0; i < 5; i++) {
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(4 - i * 0.6, 0.2, 6, 36),
        new THREE.MeshBasicMaterial({ color: bandColors[i % 3], transparent: true, opacity: 0.5 })
      );
      band.rotation.x = Math.PI / 2;
      band.position.y = -0.3 + i * 0.15;
      planet.add(band);
    }
    // Saturn's iconic rings (horizontal disc around the planet)
    const rings = new THREE.Mesh(
      new THREE.RingGeometry(5.5, 9, 80),
      new THREE.MeshBasicMaterial({ color: 0xe0d0a0, transparent: true, opacity: 0.65, side: THREE.DoubleSide, fog: false })
    );
    rings.rotation.x = Math.PI / 2 - 0.25;   // slight tilt
    planet.add(rings);
    // Inner darker ring + outer brighter ring for depth
    const rings2 = new THREE.Mesh(
      new THREE.RingGeometry(6.4, 6.7, 80),
      new THREE.MeshBasicMaterial({ color: 0x6a5430, transparent: true, opacity: 0.7, side: THREE.DoubleSide, fog: false })
    );
    rings2.rotation.copy(rings.rotation);
    planet.add(rings2);
    const rings3 = new THREE.Mesh(
      new THREE.RingGeometry(8.2, 8.6, 80),
      new THREE.MeshBasicMaterial({ color: 0xfff0c8, transparent: true, opacity: 0.65, side: THREE.DoubleSide, fog: false })
    );
    rings3.rotation.copy(rings.rotation);
    planet.add(rings3);
  }
  if (scene.userData.charon) scene.userData.charon.visible = false;

  // ── Ring debris streaming past the cockpit (chunks of ice/rock) ──
  const debris = [];
  const debrisMat = new THREE.MeshStandardMaterial({ color: 0xc0b090, roughness: 0.7, metalness: 0.15 });
  const debrisCount = isTouchDevice() ? 28 : 60;
  for (let i = 0; i < debrisCount; i++) {
    const r = 0.15 + Math.random() * 0.45;
    const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), debrisMat);
    chunk.position.set(
      (Math.random() - 0.5) * 32,
      (Math.random() - 0.5) * 18,
      -10 - Math.random() * 110,
    );
    chunk.userData.spin = new THREE.Vector3(Math.random()*2, Math.random()*2, Math.random()*2);
    chunk.userData.scroll = 30 + Math.random() * 20;
    scene.add(chunk);
    debris.push(chunk);
  }
  scene.userData.ringDebris = debris;

  scene.userData.spacePhase = 'fight';
  scene.userData.spaceTarget = 'saturn';
}

// ─── Enemy: Star-Wars-Style Fighter (TIE + X-Wing variants) ─────────────────
function spawnFighter(kind, x, y, z) {
  const f = new THREE.Group();
  const isTie = kind === 'tie';
  const hullMat = new THREE.MeshStandardMaterial({
    color: isTie ? 0x303a44 : 0xc0c0c8, metalness: 0.5, roughness: 0.4,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: isTie ? 0x60707a : 0xa83030, metalness: 0.5, roughness: 0.5,
  });
  const cockpitMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a28, metalness: 0.7, roughness: 0.2,
    emissive: 0x202040, emissiveIntensity: 0.5,
  });
  const blastMat = new THREE.MeshBasicMaterial({ color: 0x60c0ff });

  if (isTie) {
    // Central hexagonal cockpit pod
    const pod = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), hullMat);
    pod.scale.set(1, 0.95, 1.1);
    f.add(pod);
    // Cockpit window (front)
    const window = new THREE.Mesh(new THREE.CircleGeometry(0.28, 14), cockpitMat);
    window.position.z = 0.58;
    f.add(window);
    // Twin solar panels (huge hexagonal wings)
    for (const sx of [-1, 1]) {
      // Strut
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.0, 8), hullMat);
      strut.rotation.z = Math.PI / 2;
      strut.position.set(sx * 0.7, 0, 0);
      f.add(strut);
      // Panel (hexagonal disc)
      const panel = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.06, 6), accentMat);
      panel.rotation.z = Math.PI / 2;
      panel.position.set(sx * 1.4, 0, 0);
      f.add(panel);
      // Panel grid lines (just a darker face plate to suggest cells)
      const grid = new THREE.Mesh(
        new THREE.CylinderGeometry(0.88, 0.88, 0.08, 6),
        new THREE.MeshBasicMaterial({ color: 0x1a1a20, transparent: true, opacity: 0.55 })
      );
      grid.rotation.z = Math.PI / 2;
      grid.position.set(sx * 1.42, 0, 0);
      f.add(grid);
      // Twin laser cannons (small posts at panel face)
      const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 6), hullMat);
      gun.rotation.x = Math.PI / 2;
      gun.position.set(sx * 1.4, 0, 0.6);
      f.add(gun);
    }
  } else {
    // X-Wing: fuselage cylinder + cross of S-foils + 4 engines
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 1.5, 12), hullMat);
    fuselage.rotation.x = Math.PI / 2;
    f.add(fuselage);
    // Pointed nose
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 10), hullMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = 1.05;
    f.add(nose);
    // Red accent stripes
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.225, 0.18, 12), accentMat);
    stripe.rotation.x = Math.PI / 2;
    stripe.position.z = 0.5;
    f.add(stripe);
    // Cockpit (small bubble on top)
    const cock = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI*2, 0, Math.PI/2),
      cockpitMat
    );
    cock.position.set(0, 0.18, 0.1);
    f.add(cock);
    // 4 S-foil wings + engines at tips (cross-shape "X")
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.45), hullMat);
      wing.position.set(0, 0, -0.3);
      wing.rotation.z = ang;
      f.add(wing);
      // Engine pod at the tip
      const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.35, 10), hullMat);
      eng.rotation.x = Math.PI / 2;
      const tipX = Math.cos(ang) * 0.8;
      const tipY = Math.sin(ang) * 0.8;
      eng.position.set(tipX, tipY, -0.3);
      f.add(eng);
      // Engine glow
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), blastMat);
      flame.position.set(tipX, tipY, -0.5);
      f.add(flame);
      // Laser cannon at the tip front
      const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 6), hullMat);
      gun.rotation.x = Math.PI / 2;
      gun.position.set(tipX, tipY, 0.4);
      f.add(gun);
    }
  }

  f.position.set(x, y, z);
  f.userData.health = diff().catHealth + 30;
  f.userData.isFighter = true;
  f.userData.isTie = isTie;
  f.userData.speed = 6 + Math.random() * 3;
  f.userData.attackTimer = 0.6 + Math.random() * 1.2;
  f.userData.driftPhase = Math.random() * Math.PI * 2;
  f.userData.bobOffset = Math.random() * Math.PI * 2;
  f.userData.hitOffsetY = 0;
  f.userData.hitRadius = isTie ? 1.5 : 1.0;
  // Each fighter flies in a curving approach pattern
  f.userData.approachT = 0;

  scene.add(f);
  ENEMIES.push(f);
  return f;
}

// ─── Missile Projectile (Saturn approach + future) ───────────────────────────
function makeMissileMesh() {
  const m = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 0.55, 10),
    new THREE.MeshStandardMaterial({ color: 0xb0b0b8, metalness: 0.7, roughness: 0.3 })
  );
  body.rotation.x = Math.PI / 2;
  m.add(body);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.07, 0.18, 10),
    new THREE.MeshStandardMaterial({ color: 0xff4040, metalness: 0.4, roughness: 0.4 })
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = 0.36;
  m.add(nose);
  // Fins (4)
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.18, 0.18),
      new THREE.MeshStandardMaterial({ color: 0x4a4a52, metalness: 0.5, roughness: 0.4 })
    );
    fin.rotation.z = (i / 4) * Math.PI * 2;
    fin.position.z = -0.18;
    fin.position.x = Math.cos((i / 4) * Math.PI * 2) * 0.1;
    fin.position.y = Math.sin((i / 4) * Math.PI * 2) * 0.1;
    m.add(fin);
  }
  // Exhaust glow at the back
  const exhaust = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff8040 })
  );
  exhaust.position.z = -0.32;
  m.add(exhaust);
  m.userData.exhaust = exhaust;
  return m;
}

function throwMissile() {
  if (STATE.missiles <= 0 || STATE.gameover) return;
  STATE.missiles--;
  updateHUD();

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  let origin;
  if (STATE.level === 'space-cockpit' || STATE.level === 'neptune-approach' || STATE.level === 'saturn-approach') {
    // Fire from underneath the dashboard center
    origin = new THREE.Vector3(0, 0.7, -1.2);
  } else {
    origin = camera.position.clone().addScaledVector(dir, 0.8);
  }

  const m = makeMissileMesh();
  m.position.copy(origin);
  const up = new THREE.Vector3(0, 0, 1);   // missile's local "forward" is +Z (built that way)
  m.quaternion.setFromUnitVectors(up, dir.clone().normalize());
  m.userData.velocity = dir.clone().multiplyScalar(40);
  m.userData.lifetime = 3;
  m.userData.damage = 90;
  m.userData.splashRadius = 3.5;
  m.userData.isMissile = true;
  scene.add(m);
  PROJECTILES.push(m);
}

function explodeMissile(missile, hitPos) {
  // Splash damage to nearby enemies
  for (let j = ENEMIES.length - 1; j >= 0; j--) {
    const e = ENEMIES[j];
    const d = e.position.distanceTo(hitPos);
    if (d < missile.userData.splashRadius) {
      // Linear falloff
      const f = 1 - d / missile.userData.splashRadius;
      e.userData.health -= missile.userData.damage * f;
      if (e.userData.health <= 0) killEnemy(j);
      else flashEnemy(e);
    }
  }
  // Visual: big orange flash + sparks
  spawnExplosionFlash(hitPos);
}

function spawnExplosionFlash(pos) {
  const flash = new THREE.PointLight(0xffa040, 8, 18, 1.5);
  flash.position.copy(pos);
  scene.add(flash);
  // Sphere flash
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 1 })
  );
  sphere.position.copy(pos);
  scene.add(sphere);
  scene.userData.explosions = scene.userData.explosions || [];
  scene.userData.explosions.push({ light: flash, sphere, life: 0.6, age: 0 });
  // Sparks
  for (let k = 0; k < 18; k++) spawnBossSparks(pos, k % 2 ? 0xff8040 : 0xffe060);
}

function updateExplosions(dt) {
  const list = scene.userData.explosions;
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const ex = list[i];
    ex.age += dt;
    const k = 1 - ex.age / ex.life;
    if (k <= 0) {
      scene.remove(ex.light);
      scene.remove(ex.sphere);
      list.splice(i, 1);
      continue;
    }
    ex.light.intensity = 8 * k;
    ex.sphere.scale.setScalar(1 + (1 - k) * 4);
    ex.sphere.material.opacity = k;
  }
}

// ─── Missile pickups ─────────────────────────────────────────────────────────
function spawnSpaceMissilePacks(count) {
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group();
    const m = makeMissileMesh();
    m.scale.setScalar(1.5);
    g.add(m);
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 7),
      new THREE.MeshBasicMaterial({ color: 0xff6040, transparent: true, opacity: 0.18, side: THREE.BackSide })
    );
    g.add(shell);
    const glow = new THREE.PointLight(0xff6040, 1.5, 4, 2);
    g.add(glow);
    g.userData.glow = glow;
    g.userData.shell = shell;
    g.userData.isMissilePack = true;
    g.userData.missiles = 2;
    placeSpacePickup(g);
    SPACE_PICKUPS.push(g);
    scene.add(g);
  }
}

// ─── Saturn Surface: red gas storm + water-gun aliens ────────────────────────
function buildSaturnSurface() {
  // Reddish gas-cloud ground (gas giants don't have a true surface — this is the upper deck)
  const groundGeo = new THREE.PlaneGeometry(70, 70, 60, 60);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x7a2a18, roughness: 0.9, metalness: 0.1,
    emissive: 0x401208, emissiveIntensity: 0.4,
  });
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, Math.sin(x * 0.35) * 0.25 + Math.cos(y * 0.4) * 0.22 + (Math.random() - 0.5) * 0.08);
  }
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Swirling cloud bands on the ground (lighter and darker streaks for atmosphere)
  for (let i = 0; i < 18; i++) {
    const band = new THREE.Mesh(
      new THREE.PlaneGeometry(8 + Math.random() * 10, 1.2 + Math.random() * 1.5),
      new THREE.MeshBasicMaterial({
        color: i % 2 ? 0xc05030 : 0xfff080,
        transparent: true, opacity: 0.18, side: THREE.DoubleSide,
      })
    );
    band.rotation.x = -Math.PI / 2;
    band.position.set((Math.random() - 0.5) * 50, 0.03, (Math.random() - 0.5) * 50);
    band.rotation.z = Math.random() * Math.PI;
    band.userData.driftPhase = Math.random() * Math.PI * 2;
    scene.add(band);
    scene.userData.cloudBands = scene.userData.cloudBands || [];
    scene.userData.cloudBands.push(band);
  }

  // ── Floating gas pillars (towers of red gas you can hide behind) ──
  const pillarMat = new THREE.MeshStandardMaterial({
    color: 0xc04020, roughness: 0.85, transparent: true, opacity: 0.75,
    emissive: 0x501008, emissiveIntensity: 0.6,
  });
  for (let i = 0; i < 9; i++) {
    const r = 0.8 + Math.random() * 0.6;
    const h = 4 + Math.random() * 3;
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.2, h, 14), pillarMat);
    let px, pz;
    do {
      px = (Math.random() - 0.5) * 38;
      pz = (Math.random() - 0.5) * 38;
    } while (px*px + pz*pz < 12);
    pillar.position.set(px, h / 2, pz);
    pillar.castShadow = true;
    scene.add(pillar);
    // Top wisp (smaller cloud puff)
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r * 1.3, 10, 8), pillarMat);
    puff.position.set(px, h + 0.2, pz);
    puff.scale.y = 0.55;
    scene.add(puff);
  }

  // ── Dome of red gas sky ──
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(80, 28, 18),
    new THREE.MeshBasicMaterial({ color: 0x5a1a08, side: THREE.BackSide, fog: false })
  );
  scene.add(sky);

  // Distant rings visible at the horizon (we're on the gas giant, so they're nearly edge-on)
  const ringsFar = new THREE.Mesh(
    new THREE.RingGeometry(45, 60, 64),
    new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.55, side: THREE.DoubleSide, fog: false })
  );
  ringsFar.rotation.x = -Math.PI / 2 + 0.08;   // almost edge-on
  ringsFar.position.y = 8;
  scene.add(ringsFar);
  // Dark inner band
  const ringsBand = new THREE.Mesh(
    new THREE.RingGeometry(50, 51.5, 64),
    new THREE.MeshBasicMaterial({ color: 0x6a4020, transparent: true, opacity: 0.55, side: THREE.DoubleSide, fog: false })
  );
  ringsBand.rotation.copy(ringsFar.rotation);
  ringsBand.position.y = 8;
  scene.add(ringsBand);

  // Lightning flash placeholder (occasional sky flash)
  const flash = new THREE.PointLight(0xffd0a0, 0.3, 50, 1);
  flash.position.set(0, 25, 0);
  scene.add(flash);
  scene.userData.saturnFlash = flash;

  // ── Wind particles (red streaks blowing past) ──
  const windGeo = new THREE.BufferGeometry();
  const WIND_COUNT = 300;
  const windPos = new Float32Array(WIND_COUNT * 3);
  for (let i = 0; i < WIND_COUNT; i++) {
    windPos[i*3 + 0] = (Math.random() - 0.5) * 60;
    windPos[i*3 + 1] = Math.random() * 8 + 0.5;
    windPos[i*3 + 2] = (Math.random() - 0.5) * 60;
  }
  windGeo.setAttribute('position', new THREE.BufferAttribute(windPos, 3));
  const windPoints = new THREE.Points(
    windGeo,
    new THREE.PointsMaterial({
      color: 0xffb088, size: 0.16, sizeAttenuation: true,
      transparent: true, opacity: 0.75, fog: true,
    })
  );
  scene.add(windPoints);
  scene.userData.windParticles = windPoints;

  // ── Lighting ──
  const amb = new THREE.AmbientLight(0xff8060, 0.9);
  scene.add(amb);
  scene.userData.ambient = amb;
  const sun = new THREE.DirectionalLight(0xffc080, 0.7);
  sun.position.set(15, 25, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(1024);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xff8050, 0x401008, 0.9);
  scene.add(hemi);

  // Initialize wind state for this level
  saturnWind.dirX = 1;
  saturnWind.dirZ = 0;
  saturnWind.mag = 0.6;
  saturnWind.phase = 0;
  saturnWind.gustTimer = 4;
}

// Build a portal to Jupiter that activates once all water-gun aliens are dead
function buildJupiterPortal() {
  // Reuse the ocean portal shape, but tinted red/orange for Jupiter
  buildOceanPortal();
  const ring = scene.userData.portalRing;
  const disc = scene.userData.portalDisc;
  if (ring) {
    ring.material.color.setHex(0x602010);
    ring.material.emissive.setHex(0xff6020);
    ring.material.emissiveIntensity = 2.0;
  }
  if (disc) {
    disc.material.color.setHex(0xffa040);
    disc.material.opacity = 0.85;
  }
  if (scene.userData.portalLight) {
    scene.userData.portalLight.color.setHex(0xff8040);
    scene.userData.portalLight.intensity = 1.4;
  }
  if (scene.userData.portal) {
    scene.userData.portal.position.set(0, 2.0, -4);
    scene.userData.portal.rotation.x = 0;
  }
  portalActive = true;
}

// ─── Enemy: Water-Gun Alien ──────────────────────────────────────────────────
function spawnWaterAlien(x, z) {
  const a = new THREE.Group();

  const skinMat = new THREE.MeshStandardMaterial({ color: 0x40a058, roughness: 0.6, emissive: 0x103018, emissiveIntensity: 0.3 });
  const suitMat = new THREE.MeshStandardMaterial({ color: 0xffd060, metalness: 0.2, roughness: 0.5 });
  const gunBodyMat = new THREE.MeshStandardMaterial({ color: 0x2080d0, metalness: 0.5, roughness: 0.4, emissive: 0x103040, emissiveIntensity: 0.5 });
  const gunTrimMat = new THREE.MeshStandardMaterial({ color: 0xd0d8e8, metalness: 0.85, roughness: 0.2 });
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x60c8ff, transparent: true, opacity: 0.7, metalness: 0.3, roughness: 0.2, emissive: 0x205080, emissiveIntensity: 0.4 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffff60 });

  // Squat legs
  for (const sx of [-0.16, 0.16]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.55, 8), suitMat);
    leg.position.set(sx, 0.28, 0);
    a.add(leg);
  }

  // Pudgy body (yellow rain-slicker)
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), suitMat);
  body.scale.set(1.1, 1.05, 1.0);
  body.position.y = 0.95;
  a.add(body);

  // Arms
  for (const sx of [-0.45, 0.45]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.6, 8), suitMat);
    arm.position.set(sx, 0.95, 0.1);
    arm.rotation.x = -0.4;
    a.add(arm);
  }

  // Head (round green alien with one big eye)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), skinMat);
  head.position.y = 1.55;
  a.add(head);
  // Big single cyclops eye
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), eyeMat);
  eye.position.set(0, 1.6, 0.27);
  a.add(eye);
  // Pupil
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  pupil.position.set(0, 1.6, 0.36);
  a.add(pupil);
  // Antenna with a bobble
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 6), skinMat);
  antenna.position.y = 1.95;
  a.add(antenna);
  const bobble = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff60a0 }));
  bobble.position.y = 2.1;
  a.add(bobble);

  // ── The WATER GUN (the centerpiece) ──
  const gun = new THREE.Group();
  // Reservoir tank on top (cyan water visible)
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.36, 12), tankMat);
  tank.rotation.x = Math.PI / 2;
  tank.position.set(0, 0.18, 0);
  gun.add(tank);
  // Tank cap
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12), gunTrimMat);
  cap.rotation.x = Math.PI / 2;
  cap.position.set(0, 0.18, 0.2);
  gun.add(cap);
  // Main barrel body (blue plastic)
  const barrelBody = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.55), gunBodyMat);
  barrelBody.position.set(0, 0, 0);
  gun.add(barrelBody);
  // Long barrel
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.085, 0.7, 10), gunBodyMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0, 0.6);
  gun.add(barrel);
  // Barrel tip ring
  const tip = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 6, 14), gunTrimMat);
  tip.rotation.y = Math.PI / 2;
  tip.position.set(0, 0, 0.95);
  gun.add(tip);
  // Trigger
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.04), gunTrimMat);
  trigger.position.set(0, -0.15, -0.18);
  gun.add(trigger);
  // Grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.28, 0.1), gunTrimMat);
  grip.position.set(0, -0.22, -0.25);
  gun.add(grip);

  // Attach to alien (held forward by the arms)
  gun.position.set(0.0, 0.95, 0.65);
  a.add(gun);
  a.userData.gun = gun;
  a.userData.gunBroken = false;
  a.userData.gunPieces = [tank, barrelBody, barrel, tip, cap];

  a.position.set(x, 0, z);
  a.userData.health = diff().catHealth + 5;
  a.userData.speed = 1.7 + Math.random() * 0.6;
  a.userData.attackTimer = 0.8 + Math.random() * 1.2;
  a.userData.bobOffset = Math.random() * Math.PI * 2;
  a.userData.isWaterAlien = true;
  a.userData.hitOffsetY = 1.0;
  a.userData.hitRadius = 0.85;

  scene.add(a);
  ENEMIES.push(a);
  return a;
}

// ─── Water/Sud Projectile (from aliens to player) ────────────────────────────
function spawnWaterBlob(fromPos, dir) {
  const blob = new THREE.Group();
  // Main translucent water sphere
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 12, 10),
    new THREE.MeshStandardMaterial({
      color: 0x60c8ff, transparent: true, opacity: 0.7,
      metalness: 0.2, roughness: 0.2,
      emissive: 0x205080, emissiveIntensity: 0.4,
    })
  );
  blob.add(core);
  // Sud bubbles around it
  for (let i = 0; i < 4; i++) {
    const bub = new THREE.Mesh(
      new THREE.SphereGeometry(0.05 + Math.random() * 0.04, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })
    );
    bub.position.set(
      (Math.random() - 0.5) * 0.25,
      (Math.random() - 0.5) * 0.25,
      (Math.random() - 0.5) * 0.25,
    );
    blob.add(bub);
  }
  blob.position.copy(fromPos);
  blob.userData.velocity = dir.clone().multiplyScalar(18);
  blob.userData.lifetime = 2.5;
  blob.userData.damage = 8;       // small but annoying
  blob.userData.isWaterBlob = true;
  scene.add(blob);
  ENEMY_PROJECTILES.push(blob);
}

// ─── Nailgun (player weapon on Saturn) ───────────────────────────────────────
const nailMat = persistMat(new THREE.MeshStandardMaterial({
  color: 0xcfd4dc, metalness: 0.85, roughness: 0.25,
  emissive: 0x202028, emissiveIntensity: 0.2,
}));

function makeNailMesh(forFlight = false) {
  // In-flight nails are noticeably bigger + brighter so the player can see them.
  // Pickup-pile nails use the smaller default size.
  const s = forFlight ? 2.4 : 1.0;
  const nail = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022 * s, 0.022 * s, 0.45 * s, 8), nailMat);
  shaft.rotation.x = Math.PI / 2;
  nail.add(shaft);
  // Flat head
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.06 * s, 0.04 * s, 10), nailMat);
  head.rotation.x = Math.PI / 2;
  head.position.z = -0.22 * s;
  nail.add(head);
  // Sharp tip (small cone)
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.022 * s, 0.08 * s, 6), nailMat);
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = 0.27 * s;
  nail.add(tip);

  if (forFlight) {
    // Bright tracer glow at the nose so it reads as a fast projectile
    const tracer = new THREE.Mesh(
      new THREE.SphereGeometry(0.10, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe080 })
    );
    tracer.position.z = 0.36 * s;
    nail.add(tracer);
    // Short orange streak behind the nail
    const streak = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.005, 0.6, 8),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85 })
    );
    streak.rotation.x = Math.PI / 2;
    streak.position.z = -0.45;
    nail.add(streak);
    // Faint point light for visibility in the murk
    const pl = new THREE.PointLight(0xffd080, 1.2, 4, 2);
    pl.position.z = 0.2;
    nail.add(pl);
  }
  return nail;
}

function throwNail() {
  if (STATE.nails <= 0 || STATE.gameover) return;
  STATE.nails--;
  updateHUD();

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  const nail = makeNailMesh(true);
  nail.position.copy(camera.position).addScaledVector(dir, 0.5);
  const up = new THREE.Vector3(0, 0, 1);
  nail.quaternion.setFromUnitVectors(up, dir.clone().normalize());
  nail.userData.velocity = dir.clone().multiplyScalar(55);
  nail.userData.lifetime = 1.5;
  nail.userData.damage = 22;
  nail.userData.isNail = true;
  scene.add(nail);
  PROJECTILES.push(nail);

  // Muzzle flash on the held nailgun tip
  if (dogBoneHeld && dogBoneHeld.userData && dogBoneHeld.userData.muzzle) {
    const muz = dogBoneHeld.userData.muzzle;
    muz.material.color.setHex(0xffffff);
    setTimeout(() => muz.material.color.setHex(0xffa040), 60);
  }
  animateThrow();
}

function swapHeldToNailgun() {
  if (!dogArm || !dogBoneHeld) return;
  dogArm.remove(dogBoneHeld);

  const ng = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8a020, metalness: 0.6, roughness: 0.3 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x202028, metalness: 0.8, roughness: 0.3 });
  // Main rectangular body
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.13, 0.34), bodyMat);
  body.position.set(0, 0.04, -0.05);
  ng.add(body);
  // Barrel
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.22, 10), trimMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.04, -0.26);
  ng.add(barrel);
  // Muzzle tip (glows briefly when firing)
  const muzzle = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffa040 })
  );
  muzzle.position.set(0, 0.04, -0.38);
  ng.add(muzzle);
  // Magazine (sticking down underneath)
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.15, 0.08), trimMat);
  mag.position.set(0, -0.08, 0.0);
  ng.add(mag);
  // Grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), trimMat);
  grip.position.set(0, -0.07, 0.12);
  ng.add(grip);
  ng.userData.muzzle = muzzle;

  ng.position.set(0.05, -0.08, 0);
  dogArm.add(ng);
  dogBoneHeld = ng;
}

// ─── Nail pickups ────────────────────────────────────────────────────────────
function spawnNailPickups(count) {
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group();
    // A small ammo box of nails on the ground
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.18, 0.28),
      new THREE.MeshStandardMaterial({ color: 0x6a4a20, roughness: 0.7 })
    );
    box.position.y = 0.09;
    g.add(box);
    // Nail bundle visible on top
    for (let k = 0; k < 6; k++) {
      const nail = makeNailMesh();
      nail.scale.setScalar(1.1);
      nail.rotation.z = -Math.PI / 2;
      nail.position.set(-0.1 + k * 0.04, 0.22, (Math.random() - 0.5) * 0.1);
      g.add(nail);
    }
    // Subtle silver glow so they're spottable
    const glow = new THREE.PointLight(0xc0d0e0, 0.6, 2.5, 2);
    glow.position.y = 0.3;
    g.add(glow);

    let px, pz;
    do {
      px = (Math.random() - 0.5) * 40;
      pz = (Math.random() - 0.5) * 40;
    } while (px*px + pz*pz < 8);
    g.position.set(px, 0, pz);
    g.userData.rotOffset = Math.random() * Math.PI * 2;
    scene.add(g);
    NAIL_PICKUPS.push(g);
  }
}

function updateNailPickups(dt) {
  for (let i = NAIL_PICKUPS.length - 1; i >= 0; i--) {
    const d = NAIL_PICKUPS[i];
    d.rotation.y += dt * 0.3;
    const dx = d.position.x - camera.position.x;
    const dz = d.position.z - camera.position.z;
    if (Math.sqrt(dx*dx + dz*dz) < 1.0) {
      const grab = 12;
      STATE.nails = Math.min(STATE.nails + grab, 60);
      updateHUD();
      showMessage(`+${grab} NAILS!`, 1100);
      scene.remove(d);
      NAIL_PICKUPS.splice(i, 1);
    }
  }
}

// ─── Saturn wind: shifts player + drifts particles ───────────────────────────
function updateSaturnWind(dt) {
  if (STATE.level !== 'saturn-surface') return;

  // Slow direction rotation
  saturnWind.phase += dt * 0.15;
  // Periodic strong gust (every 5-9 sec)
  saturnWind.gustTimer -= dt;
  let gustBoost = 0;
  if (saturnWind.gustTimer <= 0) {
    saturnWind.gustTimer = 5 + Math.random() * 4;
    // Trigger a brief shake/scream message occasionally
    if (Math.random() < 0.5) showMessage('A GUST! HOLD ON! 🌪️', 1100);
  }
  // Gust strength curve: peaks shortly after timer reset
  const sinceGust = (5 + 4) - saturnWind.gustTimer;       // approx
  if (sinceGust < 1.2) {
    gustBoost = 1.6 * (1 - sinceGust / 1.2);
  }
  // Base wind: slowly rotating direction at moderate strength
  saturnWind.dirX = Math.cos(saturnWind.phase);
  saturnWind.dirZ = Math.sin(saturnWind.phase);
  const baseMag = 0.6;
  saturnWind.mag = baseMag + gustBoost;

  // Apply force to player camera
  camera.position.x += saturnWind.dirX * saturnWind.mag * dt;
  camera.position.z += saturnWind.dirZ * saturnWind.mag * dt;
  // Clamp inside bounds
  const [BX, BZ] = levelBounds(STATE.level);
  camera.position.x = Math.max(-BX, Math.min(BX, camera.position.x));
  camera.position.z = Math.max(-BZ, Math.min(BZ, camera.position.z));

  // Drift wind particle field
  const wp = scene.userData.windParticles;
  if (wp) {
    const pos = wp.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i) + saturnWind.dirX * saturnWind.mag * 8 * dt;
      let z = pos.getZ(i) + saturnWind.dirZ * saturnWind.mag * 8 * dt;
      if (x >  30) x -= 60;
      if (x < -30) x += 60;
      if (z >  30) z -= 60;
      if (z < -30) z += 60;
      pos.setX(i, x);
      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
  }

  // Drift cloud bands the same way (slower)
  const bands = scene.userData.cloudBands;
  if (bands) {
    for (const b of bands) {
      b.position.x += saturnWind.dirX * saturnWind.mag * 1.5 * dt;
      b.position.z += saturnWind.dirZ * saturnWind.mag * 1.5 * dt;
      if (b.position.x >  30) b.position.x -= 60;
      if (b.position.x < -30) b.position.x += 60;
      if (b.position.z >  30) b.position.z -= 60;
      if (b.position.z < -30) b.position.z += 60;
    }
  }
}

// ─── Jupiter Surface: stormy cloud deck + tennis balls + bite weapon ────────
const JUPITER_DIG = { mesh: null, active: false };
const jupiterWind = { dirX: 1, dirZ: 0, mag: 0, phase: 0, gustTimer: 0 };

function buildJupiterSurface() {
  // Cloud-deck "ground" — Jovian banded swirls
  const groundGeo = new THREE.PlaneGeometry(80, 80, 50, 50);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xc06a30, roughness: 0.85, metalness: 0.05,
    emissive: 0x602010, emissiveIntensity: 0.5,
  });
  // Bumpy upper deck
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i,
      Math.sin(x * 0.3) * 0.4 + Math.cos(y * 0.5) * 0.3 +
      Math.sin(x * 0.12 + y * 0.18) * 0.7 +
      (Math.random() - 0.5) * 0.15
    );
  }
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Jovian latitude bands — alternating cream and rust streaks across the deck
  const bandColors = [0xf0d0a0, 0xb05030, 0xfff0c0, 0x90402a, 0xe8b070];
  for (let i = 0; i < 24; i++) {
    const yz = -28 + (i / 24) * 56;
    const cidx = i % bandColors.length;
    const band = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 1.6 + Math.random() * 1.2),
      new THREE.MeshBasicMaterial({ color: bandColors[cidx], transparent: true, opacity: 0.32 })
    );
    band.rotation.x = -Math.PI / 2;
    band.position.set((Math.random() - 0.5) * 6, 0.05, yz);
    scene.add(band);
    scene.userData.jupiterBands = scene.userData.jupiterBands || [];
    scene.userData.jupiterBands.push(band);
  }

  // The Great Red Spot looming on the horizon (a slowly rotating disc in the sky)
  const spot = new THREE.Mesh(
    new THREE.CircleGeometry(8, 48),
    new THREE.MeshBasicMaterial({ color: 0x8a2010, transparent: true, opacity: 0.85, fog: false })
  );
  spot.position.set(-15, 14, -45);
  scene.add(spot);
  const spotRing = new THREE.Mesh(
    new THREE.RingGeometry(7.5, 8.4, 64),
    new THREE.MeshBasicMaterial({ color: 0xff5028, transparent: true, opacity: 0.7, side: THREE.DoubleSide, fog: false })
  );
  spotRing.position.copy(spot.position);
  scene.add(spotRing);
  scene.userData.greatRedSpot = spot;
  scene.userData.greatRedSpotRing = spotRing;
  // Storm core (lighter centre)
  const spotEye = new THREE.Mesh(
    new THREE.CircleGeometry(2.0, 36),
    new THREE.MeshBasicMaterial({ color: 0xf0a060, transparent: true, opacity: 0.7, fog: false })
  );
  spotEye.position.set(-15, 14, -44.8);
  scene.add(spotEye);

  // Sky dome (warm rust + cream gradient via two hemispheres of color)
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(90, 28, 18),
    new THREE.MeshBasicMaterial({ color: 0x804020, side: THREE.BackSide, fog: false })
  );
  scene.add(sky);

  // Drifting cloud puffs at varying altitudes
  const puffMat = new THREE.MeshStandardMaterial({
    color: 0xf0c890, transparent: true, opacity: 0.55,
    roughness: 0.9, emissive: 0x402010, emissiveIntensity: 0.4,
  });
  for (let i = 0; i < 16; i++) {
    const r = 1.2 + Math.random() * 1.8;
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), puffMat);
    puff.position.set(
      (Math.random() - 0.5) * 60,
      4 + Math.random() * 12,
      (Math.random() - 0.5) * 60,
    );
    puff.scale.y = 0.4;
    scene.add(puff);
    scene.userData.jupiterPuffs = scene.userData.jupiterPuffs || [];
    scene.userData.jupiterPuffs.push(puff);
  }

  // Wind streaks at deck level
  const windGeo = new THREE.BufferGeometry();
  const WIND_COUNT = 250;
  const windPos = new Float32Array(WIND_COUNT * 3);
  for (let i = 0; i < WIND_COUNT; i++) {
    windPos[i*3 + 0] = (Math.random() - 0.5) * 70;
    windPos[i*3 + 1] = 0.4 + Math.random() * 4;
    windPos[i*3 + 2] = (Math.random() - 0.5) * 70;
  }
  windGeo.setAttribute('position', new THREE.BufferAttribute(windPos, 3));
  const windPoints = new THREE.Points(
    windGeo,
    new THREE.PointsMaterial({
      color: 0xffd0a0, size: 0.18, sizeAttenuation: true,
      transparent: true, opacity: 0.75, fog: true,
    })
  );
  scene.add(windPoints);
  scene.userData.jupiterWindParticles = windPoints;

  // Lightning flash placeholder
  const flash = new THREE.PointLight(0xffe0c0, 0.4, 80, 1);
  flash.position.set(0, 30, 0);
  scene.add(flash);
  scene.userData.jupiterFlash = flash;

  // Lighting
  const amb = new THREE.AmbientLight(0xffa860, 1.0);
  scene.add(amb);
  scene.userData.ambient = amb;
  const sun = new THREE.DirectionalLight(0xffe0a0, 0.8);
  sun.position.set(15, 25, 5);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xffd090, 0x402010, 0.9);
  scene.add(hemi);

  // Initial wind state
  jupiterWind.dirX = 0.7;
  jupiterWind.dirZ = 0.7;
  jupiterWind.mag = 0.9;
  jupiterWind.phase = 0;
  jupiterWind.gustTimer = 3;
  JUPITER_DIG.mesh = null;
  JUPITER_DIG.active = false;
}

// Spawn the glowing dig spot once tennis balls are cleared.
function buildJupiterDigSpot() {
  const g = new THREE.Group();
  // Crater rim
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(1.6, 0.25, 12, 36),
    new THREE.MeshStandardMaterial({ color: 0x603020, roughness: 0.7, emissive: 0x301008, emissiveIntensity: 0.6 })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.15;
  g.add(rim);
  // Glowing core
  const core = new THREE.Mesh(
    new THREE.CircleGeometry(1.4, 36),
    new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  core.rotation.x = -Math.PI / 2;
  core.position.y = 0.02;
  g.add(core);
  // Hot rising sparks (just a glow)
  const glow = new THREE.PointLight(0xff8040, 2.2, 8, 2);
  glow.position.y = 1;
  g.add(glow);
  g.userData.glow = glow;
  g.userData.core = core;
  // Place it near the center of the plain, somewhere visible
  g.position.set(4, 0, -3);
  scene.add(g);
  JUPITER_DIG.mesh = g;
  JUPITER_DIG.active = true;
}

// ─── Enemy: Giant Tennis Ball ────────────────────────────────────────────────
function spawnTennisBall(x, z) {
  const t = new THREE.Group();
  const feltMat = new THREE.MeshStandardMaterial({
    color: 0xd0e840, roughness: 0.95, metalness: 0.0,
    emissive: 0x303808, emissiveIntensity: 0.35,
  });
  const seamMat = new THREE.MeshBasicMaterial({ color: 0xfff8e0 });

  const R = 0.85;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 22, 16), feltMat);
  t.add(ball);

  // Two curved white seams — built as thin tori half-rings, offset like real tennis ball seams
  for (let sign of [-1, 1]) {
    const seam = new THREE.Mesh(
      new THREE.TorusGeometry(R * 0.96, 0.045, 8, 36, Math.PI * 1.05),
      seamMat
    );
    seam.rotation.x = Math.PI / 2;
    seam.rotation.y = sign > 0 ? 0.45 : Math.PI + 0.45;
    seam.position.y = sign * 0.0;
    t.add(seam);
  }

  // Fuzzy halo (slightly larger transparent sphere for the "fuzz" silhouette)
  const fuzz = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.06, 18, 12),
    new THREE.MeshBasicMaterial({ color: 0xe0f060, transparent: true, opacity: 0.18, side: THREE.BackSide })
  );
  t.add(fuzz);

  t.position.set(x, R, z);
  t.userData.health = 100;             // 2 bites at 55 dmg
  t.userData.speed = 4.2 + Math.random() * 1.2;   // chase speed (faster than walk)
  t.userData.bobOffset = Math.random() * Math.PI * 2;
  t.userData.isTennisBall = true;
  t.userData.bounceVy = 0;             // vertical velocity for bouncing
  t.userData.spin = Math.random() * Math.PI * 2;
  t.userData.hitOffsetY = R;
  t.userData.hitRadius = R + 0.1;

  scene.add(t);
  ENEMIES.push(t);
  return t;
}

// ─── Bite weapon (Jupiter surface) ───────────────────────────────────────────
function biteAttack() {
  if (STATE.gameover) return;
  // Find nearest enemy in front of player, within bite range.
  const BITE_RANGE = 2.2;
  const BITE_HALF_CONE = Math.cos(Math.PI / 3);   // 60° cone (cos 60 = 0.5)
  const dir = camera.getWorldDirection(SCRATCH.vA);
  let best = null, bestDist = BITE_RANGE;
  for (const e of ENEMIES) {
    const dx = e.position.x - camera.position.x;
    const dz = e.position.z - camera.position.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    if (dist > BITE_RANGE) continue;
    const dot = (dx * dir.x + dz * dir.z) / (dist || 1);
    if (dot < BITE_HALF_CONE) continue;    // not in front
    if (dist < bestDist) { bestDist = dist; best = e; }
  }
  // Animate the held item (snap forward)
  animateBite();
  if (!best) return;
  best.userData.health -= 55;
  // Brief recoil/push so the ball bounces away
  const away = SCRATCH.vB.set(best.position.x - camera.position.x, 0, best.position.z - camera.position.z).normalize();
  best.position.x += away.x * 0.6;
  best.position.z += away.z * 0.6;
  best.userData.bounceVy = Math.max(best.userData.bounceVy, 6);
  // Death + a poof of yellow felt particles
  if (best.userData.health <= 0) {
    spawnTennisBallPop(best.position.clone());
    const idx = ENEMIES.indexOf(best);
    if (idx !== -1) killEnemy(idx);
  } else {
    flashEnemy(best);
  }
}

function animateBite() {
  if (!dogBoneHeld) return;
  const baseZ = dogBoneHeld.position.z || 0;
  let t = 0;
  const anim = () => {
    t += 0.08;
    dogBoneHeld.position.z = baseZ - Math.sin(t * Math.PI) * 0.18;
    if (t < 1) requestAnimationFrame(anim);
    else dogBoneHeld.position.z = baseZ;
  };
  requestAnimationFrame(anim);
}

function spawnTennisBallPop(pos) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xd0e840 });
  for (let i = 0; i < 14; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.08, 5, 4), mat);
    p.position.copy(pos).add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.6,
      Math.random() * 0.6,
      (Math.random() - 0.5) * 0.6,
    ));
    p.userData.vel = new THREE.Vector3(
      (Math.random() - 0.5) * 4,
      Math.random() * 5 + 2,
      (Math.random() - 0.5) * 4,
    );
    p.userData.life = 0.7;
    scene.add(p);
    scene.userData.particles = scene.userData.particles || [];
    scene.userData.particles.push(p);
  }
}

// Replace the held item with a "fangs" indicator on Jupiter
function swapHeldToFangs() {
  if (!dogArm || !dogBoneHeld) return;
  dogArm.remove(dogBoneHeld);
  const g = new THREE.Group();
  // Two small fang triangles peeking up at the bottom of the view
  const fangMat = new THREE.MeshStandardMaterial({ color: 0xfff8e0, roughness: 0.6, emissive: 0x602010 });
  for (const sx of [-0.06, 0.06]) {
    const fang = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 6), fangMat);
    fang.rotation.x = Math.PI;
    fang.position.set(sx, -0.02, 0);
    g.add(fang);
  }
  // Pink tongue / mouth interior hint
  const tongue = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xff7090, roughness: 0.6, emissive: 0x401020 })
  );
  tongue.scale.set(1.0, 0.4, 0.55);
  tongue.position.set(0, -0.12, -0.02);
  g.add(tongue);
  g.position.set(0.0, -0.18, -0.02);
  dogArm.add(g);
  dogBoneHeld = g;
}

// Wind + storm update (called each frame in updateAtmosphere)
function updateJupiterStorm(dt) {
  if (STATE.level !== 'jupiter-surface') return;
  const t = clock.getElapsedTime();
  jupiterWind.phase += dt * 0.2;
  jupiterWind.gustTimer -= dt;
  let gust = 0;
  if (jupiterWind.gustTimer <= 0) {
    jupiterWind.gustTimer = 3.5 + Math.random() * 4;
    if (Math.random() < 0.55) showMessage('A JOVIAN GUST! 🌪️', 1100);
  }
  const sinceGust = (3.5 + 4) - jupiterWind.gustTimer;
  if (sinceGust < 1.4) gust = 2.2 * (1 - sinceGust / 1.4);
  jupiterWind.dirX = Math.cos(jupiterWind.phase);
  jupiterWind.dirZ = Math.sin(jupiterWind.phase);
  jupiterWind.mag = 0.9 + gust;
  camera.position.x += jupiterWind.dirX * jupiterWind.mag * dt;
  camera.position.z += jupiterWind.dirZ * jupiterWind.mag * dt;
  const [BX, BZ] = levelBounds(STATE.level);
  camera.position.x = Math.max(-BX, Math.min(BX, camera.position.x));
  camera.position.z = Math.max(-BZ, Math.min(BZ, camera.position.z));

  // Drift the wind particle cloud
  const wp = scene.userData.jupiterWindParticles;
  if (wp) {
    const pos = wp.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i) + jupiterWind.dirX * jupiterWind.mag * 10 * dt;
      let z = pos.getZ(i) + jupiterWind.dirZ * jupiterWind.mag * 10 * dt;
      if (x >  35) x -= 70;
      if (x < -35) x += 70;
      if (z >  35) z -= 70;
      if (z < -35) z += 70;
      pos.setX(i, x);
      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
  }
  // Bands drift slowly
  const bands = scene.userData.jupiterBands;
  if (bands) {
    for (const b of bands) {
      b.position.x += jupiterWind.dirX * jupiterWind.mag * 0.8 * dt;
      if (b.position.x >  30) b.position.x -= 60;
      if (b.position.x < -30) b.position.x += 60;
    }
  }
  // Cloud puffs drift overhead
  const puffs = scene.userData.jupiterPuffs;
  if (puffs) {
    for (const p of puffs) {
      p.position.x += jupiterWind.dirX * jupiterWind.mag * 0.4 * dt;
      p.position.z += jupiterWind.dirZ * jupiterWind.mag * 0.4 * dt;
      if (p.position.x >  35) p.position.x -= 70;
      if (p.position.x < -35) p.position.x += 70;
      if (p.position.z >  35) p.position.z -= 70;
      if (p.position.z < -35) p.position.z += 70;
    }
  }
  // Great Red Spot slow rotation
  if (scene.userData.greatRedSpotRing) scene.userData.greatRedSpotRing.rotation.z = t * 0.15;
  // Lightning
  const flash = scene.userData.jupiterFlash;
  if (flash) {
    const strike = Math.sin(t * 0.5) * Math.sin(t * 1.9) > 0.91;
    flash.intensity = strike ? 5.5 + Math.random() * 3 : 0.4 + Math.sin(t * 2) * 0.15;
  }
  // Dig spot pulse
  if (JUPITER_DIG.mesh) {
    JUPITER_DIG.mesh.rotation.y += dt * 0.6;
    if (JUPITER_DIG.mesh.userData.glow) {
      JUPITER_DIG.mesh.userData.glow.intensity = 1.6 + Math.sin(t * 4) * 0.8;
    }
    if (JUPITER_DIG.mesh.userData.core) {
      JUPITER_DIG.mesh.userData.core.material.opacity = 0.6 + Math.sin(t * 4) * 0.3;
    }
  }
}

// Update tennis-ball behavior (chase/bounce/flee). Called from updateEnemies.
function updateTennisBall(e, dt, t) {
  // XZ vector toward player
  const to = SCRATCH.vA.set(camera.position.x - e.position.x, 0, camera.position.z - e.position.z);
  const dist = to.length();
  if (dist > 0.001) to.multiplyScalar(1 / dist);

  // Behavior: bolt AWAY when too close (just been bitten), chase when far
  let moveDir;
  if (dist < 2.5) {
    moveDir = to.clone().multiplyScalar(-1);   // flee a little
  } else if (dist < 18) {
    moveDir = to;                              // chase
  } else {
    moveDir = to;                              // close in
  }
  e.position.x += moveDir.x * e.userData.speed * dt;
  e.position.z += moveDir.z * e.userData.speed * dt;

  // Bouncing: gravity-like vertical motion with ground bounce
  e.userData.bounceVy -= 18 * dt;
  e.position.y += e.userData.bounceVy * dt;
  const restY = e.userData.hitRadius || 0.95;
  if (e.position.y < restY) {
    e.position.y = restY;
    // Bounce with energy loss; occasionally hop on its own
    if (e.userData.bounceVy < -0.5) {
      e.userData.bounceVy = -e.userData.bounceVy * 0.7;
    } else if (Math.random() < 0.02) {
      e.userData.bounceVy = 4 + Math.random() * 3;
    } else {
      e.userData.bounceVy = 0;
    }
  }

  // Spin while moving
  e.userData.spin += dt * 6;
  e.rotation.x = e.userData.spin;
  e.rotation.z = Math.sin(t + e.userData.bobOffset) * 0.3;
}

// ─── Cat Ship Hijack (room 15) ───────────────────────────────────────────────
function buildCatShipHijack() {
  // Re-use the cockpit shell as the base
  buildSpaceCockpit();
  // Replace Pluto with… nothing in particular; we'll cover with overlay quickly
  if (scene.userData.pluto) scene.userData.pluto.visible = false;
  if (scene.userData.charon) scene.userData.charon.visible = false;

  // Add cat-themed decorations to the cockpit
  const cockpit = scene.userData.cockpit;
  if (cockpit) {
    // Big cat ear silhouettes on top of the dashboard frame
    const earMat = new THREE.MeshStandardMaterial({ color: 0x2a1a1a, roughness: 0.8 });
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.45, 6), earMat);
      ear.position.set(sx * 1.6, 1.95, -0.9);
      ear.rotation.z = sx * 0.2;
      cockpit.add(ear);
    }
    // Glowing cat eye sigil over the dashboard center
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffe060 });
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), eyeMat);
    eye.scale.set(1, 1.6, 0.4);
    eye.position.set(0, 1.55, -0.85);
    cockpit.add(eye);
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    pupil.scale.set(0.4, 1.8, 0.5);
    pupil.position.set(0, 1.55, -0.78);
    cockpit.add(pupil);
  }

  // Bars across the viewport — you are CAGED in the cat ship at start
  const barsGroup = new THREE.Group();
  const barMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.8, roughness: 0.4 });
  for (let i = -2; i <= 2; i++) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 8), barMat);
    bar.position.set(i * 0.5, 1.25, -0.95);
    barsGroup.add(bar);
  }
  scene.add(barsGroup);
  scene.userData.cageBars = barsGroup;

  // No stars/streaks scrolling — we're docked in the cat ship
  if (scene.userData.stars) scene.userData.stars.visible = false;
  if (scene.userData.streaks) scene.userData.streaks.visible = false;
}

function startCatShipHijackSequence() {
  // Phase 1: stuck. Phase 2: cage breaks. Phase 3: fighter takes off. Phase 4: fade to victory.
  showMessage('YOU\'RE IN A CAT SHIP CAGE… 😾', 2800);
  const overlay = document.getElementById('transition-overlay');

  setTimeout(() => {
    showMessage('YOU CHEW THROUGH THE BARS! 🦷', 2800);
    const bars = scene.userData.cageBars;
    if (bars) {
      for (const bar of bars.children) {
        bar.userData.fallVel = (Math.random() - 0.5) * 3;
        bar.userData.gravVy = 0;
      }
      scene.userData.barsFalling = true;
    }
  }, 3000);

  setTimeout(() => {
    showMessage('HIJACK! YOU ARE THE FIGHTER NOW! 🚀😼', 3000);
    if (scene.userData.stars) scene.userData.stars.visible = true;
    if (scene.userData.streaks) scene.userData.streaks.visible = true;
    if (scene.userData.pluto) {
      scene.userData.pluto.visible = true;
      scene.userData.pluto.position.z = -120;
      // Re-skin to a generic alien planet
      scene.userData.pluto.material.color.setHex(0x6080a0);
      scene.userData.pluto.material.emissive.setHex(0x102030);
      scene.userData.pluto.material.needsUpdate = true;
    }
    scene.userData.spacePhase = 'fight';
  }, 6000);

  setTimeout(() => {
    showMessage('LIGHTSPEED ENGAGED 🌌', 2500);
    scene.userData.spacePhase = 'approach';
  }, 9000);

  setTimeout(() => {
    overlay.style.background = '#fff';
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.opacity = '1'; }, 600);
    setTimeout(() => {
      overlay.style.background = '#000';
      victoryGame();
    }, 1400);
  }, 11500);
}

function updateCatShipHijack(dt) {
  if (STATE.level !== 'cat-ship-hijack') return;
  // Drop the cage bars after the player chews through
  if (scene.userData.barsFalling && scene.userData.cageBars) {
    for (const bar of scene.userData.cageBars.children) {
      bar.userData.gravVy = (bar.userData.gravVy || 0) - 18 * dt;
      bar.position.y += bar.userData.gravVy * dt;
      bar.position.x += (bar.userData.fallVel || 0) * dt;
      bar.rotation.z += dt * 2;
    }
  }
}

// ─── Laser Projectile (space) ────────────────────────────────────────────────
const laserMat = persistMat(new THREE.MeshBasicMaterial({ color: 0x60ffff }));

function makeLaserMesh(color = 0x60ffff) {
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1.0, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
  );
  beam.rotation.x = Math.PI / 2;
  return beam;
}

function throwLaser() {
  if (STATE.lasers <= 0 || STATE.gameover) return;
  STATE.lasers--;
  updateHUD();

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  // Origin: cockpit fires from the under-viewport cannons; on foot it's from the blaster
  let origin;
  if (STATE.level === 'space-cockpit') {
    scene.userData.laserSide = (scene.userData.laserSide || 0) ^ 1;
    const side = scene.userData.laserSide ? -1 : 1;
    origin = new THREE.Vector3(side * 1.3, 0.85, -2.0);
  } else {
    origin = camera.position.clone().addScaledVector(dir, 0.6);
  }

  const beam = makeLaserMesh(0x60ffff);
  beam.position.copy(origin);
  const up = new THREE.Vector3(0, 1, 0);
  beam.quaternion.setFromUnitVectors(up, dir.clone().normalize());
  beam.userData.velocity = dir.clone().multiplyScalar(80);
  beam.userData.lifetime = 2;
  beam.userData.damage = 35;
  beam.userData.isLaser = true;
  scene.add(beam);
  PROJECTILES.push(beam);

  // Muzzle flash on cockpit cannon tip (cockpit only)
  const tips = scene.userData.cannonTips;
  if (tips && STATE.level === 'space-cockpit') {
    const tipIdx = scene.userData.laserSide ? 0 : 1;
    const tip = tips[tipIdx];
    if (tip) {
      tip.material.color.setHex(0xffffff);
      setTimeout(() => tip.material.color.setHex(0x40ffff), 80);
    }
  }
}

function spawnEnemyLaser(fromPos, dir, damage = 12) {
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff4060, transparent: true, opacity: 0.95 })
  );
  beam.rotation.x = Math.PI / 2;
  beam.position.copy(fromPos);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  beam.userData.velocity = dir.clone().multiplyScalar(28);
  beam.userData.lifetime = 3;
  beam.userData.damage = damage;
  scene.add(beam);
  ENEMY_PROJECTILES.push(beam);
}

function addOceanLighting() {
  // Bright daylight ambient
  const amb = new THREE.AmbientLight(0xffffff, 1.4);
  scene.add(amb);
  scene.userData.ambient = amb;

  // Sun (directional)
  const sun = new THREE.DirectionalLight(0xfff1c0, 2.2);
  sun.position.set(15, 25, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(1024);
  sun.shadow.camera.left = -25;
  sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -25;
  scene.add(sun);

  // Sky hemisphere for soft sky/sea color split
  const hemi = new THREE.HemisphereLight(0xb8e0ff, 0x1a5b8a, 1.0);
  scene.add(hemi);
}

// ─── Lighting ─────────────────────────────────────────────────────────────────
function addLighting() {
  const D = diff();

  // Ambient — bright warm base
  const ambient = new THREE.AmbientLight(0x9070d0, D.ambient);
  scene.add(ambient);
  scene.userData.ambient = ambient;

  // Central hanging lantern — sickly green flicker
  const lantern = new THREE.PointLight(0x88ffaa, D.lantern, 28, 1.5);
  lantern.position.set(0, 4.5, 0);
  lantern.castShadow = true;
  lantern.shadow.mapSize.setScalar(512);
  scene.add(lantern);
  scene.userData.lantern = lantern;

  // Corner sconces — warm orange, much brighter
  const sconce1 = new THREE.PointLight(0xff7722, D.sconceWarm, 14, 1.5);
  sconce1.position.set(-7, 2.5, -7);
  scene.add(sconce1);

  const sconce2 = new THREE.PointLight(0xff7722, D.sconceWarm, 14, 1.5);
  sconce2.position.set(7, 2.5, -7);
  scene.add(sconce2);

  const sconce3 = new THREE.PointLight(0xff5500, D.sconceCool, 14, 1.5);
  sconce3.position.set(-7, 2.5, 7);
  scene.add(sconce3);

  const sconce4 = new THREE.PointLight(0xff5500, D.sconceCool, 14, 1.5);
  sconce4.position.set(7, 2.5, 7);
  scene.add(sconce4);
  scene.userData.sconces = [sconce1, sconce2, sconce3, sconce4];

  // Eerie blue mist from vents
  const mistLight = new THREE.PointLight(0x4488ff, 2.0, 14, 1.5);
  mistLight.position.set(0, 0.2, -9);
  scene.add(mistLight);
}

// ─── Room Geometry ────────────────────────────────────────────────────────────
function buildRoom(roomNum) {
  const W = 20, H = 6, D = 20;

  // Texture-like materials using procedural colors + normal maps
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x4a3a52,
    roughness: 0.9,
    metalness: 0.05,
  });
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x352a38,
    roughness: 0.95,
    metalness: 0,
  });
  const ceilMat = new THREE.MeshStandardMaterial({
    color: 0x2a2030,
    roughness: 0.95,
    metalness: 0,
  });

  // Floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D, 20, 20), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D, 20, 20), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  ceil.receiveShadow = true;
  scene.add(ceil);

  // Walls
  const wallDef = [
    { pos: [0, H/2, -D/2], rot: [0,0,0],         size: [W, H] },
    { pos: [0, H/2,  D/2], rot: [0, Math.PI, 0],  size: [W, H] },
    { pos: [-W/2, H/2, 0], rot: [0, Math.PI/2,0], size: [D, H] },
    { pos: [ W/2, H/2, 0], rot: [0,-Math.PI/2,0], size: [D, H] },
  ];
  for (const w of wallDef) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...w.size, 10, 4), wallMat);
    mesh.position.set(...w.pos);
    mesh.rotation.set(...w.rot);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
  }

  // Stone pillars
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1e1520, roughness: 0.9 });
  const pillarPositions = [[-6,-6],[6,-6],[-6,6],[6,6]];
  for (const [px, pz] of pillarPositions) {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, H, 8),
      pillarMat
    );
    pillar.position.set(px, H/2, pz);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    scene.add(pillar);

    // Pillar top cap
    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.2, 1.0), pillarMat);
    cap.position.set(px, H - 0.1, pz);
    scene.add(cap);

    // Glowing rune on each pillar
    addRuneDecal(px, 2.5, pz);
  }

  // Floor cracks / pentagram-ish pattern
  addFloorPattern();

  // Hanging chains from ceiling
  addChains();

  // Skull pile decorations
  addSkullPiles();

  // Door arch (north wall) — opens when room is cleared
  addDoorArch(roomNum);

  // Wall sconce torches
  addTorches();

  // Ceiling cobweb strands
  addCobwebs();
}

function addRuneDecal(x, y, z) {
  // Glowing rune sprite
  const geo = new THREE.PlaneGeometry(0.5, 0.5);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x00ff88,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
  });
  const rune = new THREE.Mesh(geo, mat);
  rune.position.set(x + 0.36, y, z);
  rune.rotation.y = -Math.PI / 2;
  scene.add(rune);
  rune.userData.flicker = Math.random() * Math.PI * 2;
  scene.userData.runes = scene.userData.runes || [];
  scene.userData.runes.push(rune);
}

function addFloorPattern() {
  // Pentagram-like ring of blood-red lines on floor
  const mat = new THREE.MeshBasicMaterial({ color: 0x660011, transparent: true, opacity: 0.6 });
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const geo = new THREE.PlaneGeometry(0.08, 3);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = angle;
    m.position.y = 0.01;
    scene.add(m);
  }
  // Center circle
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.8, 3.0, 32),
    new THREE.MeshBasicMaterial({ color: 0x880011, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);
}

function addChains() {
  const chainMat = new THREE.MeshStandardMaterial({ color: 0x3a3035, roughness: 0.8, metalness: 0.6 });
  const chainPositions = [[3, 0], [-3, 3], [0, -3]];
  for (const [cx, cz] of chainPositions) {
    const numLinks = 8;
    for (let i = 0; i < numLinks; i++) {
      const link = new THREE.Mesh(
        new THREE.TorusGeometry(0.07, 0.025, 6, 8),
        chainMat
      );
      link.position.set(cx, 5.8 - i * 0.3, cz);
      link.rotation.x = (i % 2) * Math.PI / 2;
      link.castShadow = true;
      scene.add(link);
    }
    // Hanging cage / lantern at bottom
    const cageGeo = new THREE.BoxGeometry(0.3, 0.4, 0.3);
    const cage = new THREE.Mesh(cageGeo, chainMat);
    cage.position.set(cx, 5.8 - numLinks * 0.3 - 0.2, cz);
    scene.add(cage);

    // Glow inside cage
    const cageLight = new THREE.PointLight(0xff3300, 0.5, 3, 2);
    cageLight.position.set(cx, 5.8 - numLinks * 0.3 - 0.2, cz);
    scene.add(cageLight);
    scene.userData.cageLights = scene.userData.cageLights || [];
    scene.userData.cageLights.push(cageLight);
  }
}

function addSkullPiles() {
  const skullMat = new THREE.MeshStandardMaterial({ color: 0xd4c89a, roughness: 0.8 });
  const pilePositions = [[-8.5, -8], [8.5, -8], [-8.5, 8]];
  for (const [px, pz] of pilePositions) {
    for (let i = 0; i < 4; i++) {
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2 - i * 0.02, 8, 6), skullMat);
      skull.position.set(
        px + (Math.random() - 0.5) * 0.6,
        0.15 + i * 0.1,
        pz + (Math.random() - 0.5) * 0.6
      );
      skull.rotation.set(
        (Math.random() - 0.5) * 0.5,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 0.5
      );
      skull.castShadow = true;
      scene.add(skull);
    }
  }
}

function addDoorArch(roomNum) {
  const archMat = new THREE.MeshStandardMaterial({ color: 0x251b30, roughness: 1 });
  // Left pillar
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 0.4), archMat);
  left.position.set(-1.5, 2, -9.8);
  scene.add(left);
  // Right pillar
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 0.4), archMat);
  right.position.set(1.5, 2, -9.8);
  scene.add(right);
  // Top arch
  const top = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.8, 0.4), archMat);
  top.position.set(0, 4.4, -9.8);
  scene.add(top);

  // Door blocker — removed when room is cleared
  const blockerMat = new THREE.MeshStandardMaterial({ color: 0x1a0a22, roughness: 1 });
  const blocker = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.8, 0.15), blockerMat);
  blocker.position.set(0, 2, -9.75);
  scene.add(blocker);
  scene.userData.doorBlocker = blocker;

  // Locked glow — red when blocked
  const exitLight = new THREE.PointLight(0xff0033, 1.5, 5, 2);
  exitLight.position.set(0, 2, -9.5);
  scene.add(exitLight);
  scene.userData.doorLight = exitLight;

  // Room label sign above door
  const signMat = new THREE.MeshStandardMaterial({ color: 0x3a1a0a, roughness: 1 });
  const sign = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 0.1), signMat);
  sign.position.set(0, 4.1, -9.75);
  scene.add(sign);
}

function addTorches() {
  const torchMat = new THREE.MeshStandardMaterial({ color: 0x4a3020, roughness: 0.9 });
  const torchPositions = [[-9.5, 2, -5], [-9.5, 2, 5], [9.5, 2, -5], [9.5, 2, 5]];
  for (const [tx, ty, tz] of torchPositions) {
    // Stick
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 6), torchMat);
    stick.position.set(tx, ty, tz);
    scene.add(stick);
    // Flame glow
    const flame = new THREE.PointLight(0xff8800, 4.0, 10, 1.5);
    flame.position.set(tx, ty + 0.4, tz);
    scene.add(flame);
    scene.userData.torchLights = scene.userData.torchLights || [];
    scene.userData.torchLights.push(flame);
  }
}

function addCobwebs() {
  const webMat = new THREE.MeshBasicMaterial({
    color: 0x888880,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
    wireframe: false,
  });
  const webPositions = [[-9, 5.8, -9], [9, 5.8, -9], [-9, 5.8, 9]];
  for (const [wx, wy, wz] of webPositions) {
    for (let r = 0; r < 3; r++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r * 0.3 + 0.1, r * 0.3 + 0.2, 8),
        webMat
      );
      ring.position.set(wx, wy, wz);
      scene.add(ring);
    }
    // Radial strands
    for (let s = 0; s < 8; s++) {
      const angle = (s / 8) * Math.PI * 2;
      const strand = new THREE.Mesh(new THREE.PlaneGeometry(0.015, 1.0), webMat);
      strand.position.set(wx + Math.cos(angle) * 0.5, wy, wz + Math.sin(angle) * 0.5);
      strand.rotation.z = angle;
      scene.add(strand);
    }
  }
}

// ─── Dog View Model ───────────────────────────────────────────────────────────
let dogArm, dogBoneHeld;
const ARM_BOB_SPEED = 8;

function buildDogViewModel() {
  // The "dog view" is an arm + paw visible in bottom-right, like Doom's weapon
  const group = new THREE.Group();

  const fur = new THREE.MeshStandardMaterial({ color: 0xc8845a, roughness: 0.9, metalness: 0 });
  const darkFur = new THREE.MeshStandardMaterial({ color: 0x8a5030, roughness: 0.9 });
  const boneMat = new THREE.MeshStandardMaterial({ color: 0xf0e8cc, roughness: 0.7 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x1a1010, roughness: 0.8 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 });
  const eyeShine = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // ── Arm (foreleg) ──
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.5, 8), fur);
  arm.position.set(0, -0.1, 0);
  group.add(arm);

  // Paw
  const paw = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), fur);
  paw.position.set(0, -0.35, 0);
  group.add(paw);

  // ── Held Bone ──
  const bone = new THREE.Group();
  // Main shaft
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 8), boneMat);
  shaft.rotation.z = Math.PI / 4;
  bone.add(shaft);
  // End knobs
  for (const sign of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), boneMat);
      const ang = (i / 2) * Math.PI / 2 + Math.PI / 4;
      knob.position.set(
        sign * 0.27 + Math.cos(ang) * 0.05,
        sign * 0.27 + Math.sin(ang) * 0.05,
        0
      );
      bone.add(knob);
    }
  }
  bone.position.set(0.05, -0.1, 0);
  group.add(bone);
  dogBoneHeld = bone;

  // Position group in camera-relative space (bottom right)
  group.position.set(0.3, -0.28, -0.5);
  camera.add(group);
  dogArm = group;

  scene.add(camera); // camera must be in scene to have children rendered
}

function swapHeldToDiamond() {
  if (!dogArm || !dogBoneHeld) return;
  dogArm.remove(dogBoneHeld);
  const gem = makeDiamondMesh(1.2);
  gem.position.set(0.05, -0.1, 0);
  dogArm.add(gem);
  dogBoneHeld = gem;
}

function swapHeldToBlaster() {
  if (!dogArm || !dogBoneHeld) return;
  dogArm.remove(dogBoneHeld);
  // Spacesuit-gloved paw holding a blocky sci-fi blaster
  const blaster = new THREE.Group();
  // Suit-gloved cuff (white, around the paw)
  const cuff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.13, 0.18, 10),
    new THREE.MeshStandardMaterial({ color: 0xf0f4f8, roughness: 0.6 })
  );
  cuff.position.set(0, -0.05, 0.05);
  blaster.add(cuff);
  // Blaster body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.12, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.7, roughness: 0.3 })
  );
  body.position.set(0, 0.04, -0.08);
  blaster.add(body);
  // Glowing barrel tip
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0x60ffff })
  );
  tip.position.set(0, 0.04, -0.27);
  blaster.add(tip);
  // Top rail glow
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.02, 0.22),
    new THREE.MeshBasicMaterial({ color: 0x40e0ff })
  );
  rail.position.set(0, 0.11, -0.08);
  blaster.add(rail);
  blaster.position.set(0.05, -0.05, 0);
  dogArm.add(blaster);
  dogBoneHeld = blaster;
}

function swapHeldToLaser() {
  if (!dogArm || !dogBoneHeld) return;
  dogArm.remove(dogBoneHeld);
  // Tiny held "laser controller" — a glowing rod
  const ctrl = new THREE.Group();
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.22, 8),
    new THREE.MeshStandardMaterial({ color: 0x202020, metalness: 0.7, roughness: 0.3 })
  );
  ctrl.add(handle);
  const emitter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.04, 0.06, 8),
    new THREE.MeshBasicMaterial({ color: 0x60ffff })
  );
  emitter.position.y = 0.13;
  ctrl.add(emitter);
  ctrl.position.set(0.05, -0.1, 0);
  ctrl.rotation.z = 0.3;
  dogArm.add(ctrl);
  dogBoneHeld = ctrl;
}

function swapHeldToBone() {
  if (!dogArm || !dogBoneHeld) return;
  dogArm.remove(dogBoneHeld);
  // Rebuild bone in paw (re-using mesh shape from buildDogViewModel)
  const boneMat = new THREE.MeshStandardMaterial({ color: 0xf5e8c0, roughness: 0.7 });
  const bone = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.36, 8), boneMat);
  bone.add(shaft);
  for (const sign of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const ang = (i / 2) * Math.PI / 2 + Math.PI / 4;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), boneMat);
      knob.position.set(
        sign * 0.27 + Math.cos(ang) * 0.05,
        sign * 0.27 + Math.sin(ang) * 0.05,
        0
      );
      bone.add(knob);
    }
  }
  bone.position.set(0.05, -0.1, 0);
  dogArm.add(bone);
  dogBoneHeld = bone;
}

// ─── Throw dispatch ──────────────────────────────────────────────────────────
function throwAmmo() {
  if (STATE.level === 'neptune-surface') return throwDirt();
  if (STATE.level === 'saturn-surface') return throwNail();
  if (STATE.level === 'jupiter-surface') return biteAttack();
  if (STATE.level === 'cat-ship-hijack') return;   // can't fire during hijack cinematic
  if (isSpaceLike(STATE.level)) return throwLaser();
  if (isOceanLike(STATE.level)) return throwDiamond();
  return throwBone();
}

// ─── Bone Projectile ─────────────────────────────────────────────────────────
const boneMat3 = persistMat(new THREE.MeshStandardMaterial({ color: 0xf0e8cc, roughness: 0.7 }));

function throwBone() {
  if (STATE.bones <= 0 || STATE.gameover) return;
  STATE.bones--;
  updateHUD();

  const bone = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.35, 8), boneMat3);
  bone.add(shaft);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const ang = (i / 2) * Math.PI / 2;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), boneMat3);
      knob.position.set(
        s * 0.2 + Math.cos(ang) * 0.04,
        s * 0.2 + Math.sin(ang) * 0.04,
        0
      );
      bone.add(knob);
    }
  }

  // Start position: from camera
  bone.position.copy(camera.position);

  // Direction: where camera is looking
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  bone.userData.velocity = dir.multiplyScalar(20);
  bone.userData.lifetime = 3;
  bone.userData.damage = 25;

  scene.add(bone);
  PROJECTILES.push(bone);

  // Throw animation
  animateThrow();
}

function animateThrow() {
  let t = 0;
  const base = dogBoneHeld.position.clone();
  const anim = () => {
    t += 0.05;
    dogBoneHeld.position.y = base.y + Math.sin(t * Math.PI) * 0.12;
    if (t < 1) requestAnimationFrame(anim);
    else dogBoneHeld.position.copy(base);
  };
  requestAnimationFrame(anim);
}

// ─── Diamond Projectile ──────────────────────────────────────────────────────
const diamondMat = persistMat(new THREE.MeshStandardMaterial({
  color: 0x7fe9ff,
  emissive: 0x4fb8d8,
  emissiveIntensity: 1.5,
  metalness: 0.6,
  roughness: 0.15,
}));

function makeDiamondMesh(scale = 1) {
  // Octahedron = diamond shape
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.18 * scale, 0), diamondMat);
  gem.scale.y = 1.4;
  return gem;
}

function throwDiamond() {
  if (STATE.diamonds <= 0 || STATE.gameover) return;
  STATE.diamonds--;
  updateHUD();

  const gem = makeDiamondMesh();
  gem.position.copy(camera.position);

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  gem.userData.velocity = dir.multiplyScalar(22);
  gem.userData.lifetime = 3;
  gem.userData.damage = 30;
  gem.userData.isDiamond = true;

  scene.add(gem);
  PROJECTILES.push(gem);

  animateThrow();
}

// ─── Enemy: Alien Cat ─────────────────────────────────────────────────────────
function spawnCat(x, z) {
  const cat = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a1a3a, roughness: 0.8 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x00ffaa });
  const alienMat = new THREE.MeshStandardMaterial({
    color: 0x1a2a1a,
    roughness: 0.7,
    emissive: 0x002200,
    emissiveIntensity: 0.3,
  });

  // Body
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), bodyMat);
  body.scale.set(1, 0.8, 1.2);
  body.position.y = 0.4;
  cat.add(body);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 8), bodyMat);
  head.position.set(0, 0.8, 0.25);
  cat.add(head);

  // Alien glow aura
  const aura = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0x00ff66, transparent: true, opacity: 0.08, side: THREE.BackSide })
  );
  aura.position.y = 0.4;
  cat.add(aura);

  // Eyes — bright alien green (MeshBasicMaterial already glows; no PointLight
  // needed. Per-enemy PointLights force Three.js to recompile every Standard
  // material's shader on wave spawn — that was the dungeon's 1-2s freeze.)
  for (const sx of [-0.1, 0.1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), eyeMat);
    eye.position.set(sx, 0.85, 0.48);
    cat.add(eye);
  }

  // Ears (pointy alien)
  for (const sx of [-0.18, 0.18]) {
    const earGeo = new THREE.ConeGeometry(0.09, 0.28, 4);
    const ear = new THREE.Mesh(earGeo, bodyMat);
    ear.position.set(sx, 1.07, 0.2);
    ear.rotation.z = sx > 0 ? -0.3 : 0.3;
    cat.add(ear);
  }

  // Tail
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.35, -0.35),
    new THREE.Vector3(-0.2, 0.6, -0.5),
    new THREE.Vector3(-0.1, 0.9, -0.4),
  ]);
  const tailGeo = new THREE.TubeGeometry(tailCurve, 10, 0.04, 6, false);
  const tail = new THREE.Mesh(tailGeo, bodyMat);
  cat.add(tail);

  // Antenna (alien!)
  const antennaMat = new THREE.MeshStandardMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.5 });
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.4, 6), antennaMat);
  antenna.position.set(0, 1.25, 0.15);
  cat.add(antenna);
  const antennaBall = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), antennaMat);
  antennaBall.position.set(0, 1.47, 0.15);
  cat.add(antennaBall);

  cat.position.set(x, 0, z);
  cat.userData.health = diff().catHealth;
  cat.userData.speed = 1.8 + Math.random() * 0.8;
  cat.userData.attackTimer = Math.random() * 2;
  cat.userData.bobOffset = Math.random() * Math.PI * 2;
  cat.userData.hitOffsetY = 0.6;   // chest height relative to group origin
  cat.userData.hitRadius = 0.85;

  scene.add(cat);
  ENEMIES.push(cat);
  return cat;
}

// ─── Enemy: Shark ─────────────────────────────────────────────────────────────
function spawnShark(x, z) {
  const shark = new THREE.Group();

  const skinMat = new THREE.MeshStandardMaterial({ color: 0x4a6878, roughness: 0.6, metalness: 0.2 });
  const bellyMat = new THREE.MeshStandardMaterial({ color: 0xb8c8d0, roughness: 0.7 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const toothMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // Body (elongated ellipsoid) — sits at water level
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), skinMat);
  body.scale.set(0.55, 0.5, 1.6);
  body.position.set(0, 0.25, 0);
  shark.add(body);

  // Belly (lighter underside)
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), bellyMat);
  belly.scale.set(0.5, 0.25, 1.5);
  belly.position.set(0, 0.05, 0);
  shark.add(belly);

  // Dorsal fin (sticks above water)
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 4), skinMat);
  fin.rotation.x = Math.PI;
  fin.rotation.z = Math.PI;
  fin.position.set(0, 0.7, -0.1);
  shark.add(fin);

  // Tail fin (vertical)
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 4), skinMat);
  tail.rotation.x = Math.PI / 2;
  tail.scale.set(1, 0.4, 1);
  tail.position.set(0, 0.3, 0.95);
  shark.add(tail);

  // Side fins
  for (const sx of [-1, 1]) {
    const sf = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.35, 4), skinMat);
    sf.rotation.z = sx * Math.PI / 2.2;
    sf.rotation.x = 0.3;
    sf.position.set(sx * 0.32, 0.15, 0.1);
    sf.scale.set(0.5, 1, 1.2);
    shark.add(sf);
  }

  // Eyes
  for (const sx of [-0.12, 0.12]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), eyeMat);
    eye.position.set(sx, 0.35, -0.5);
    shark.add(eye);
  }

  // Teeth row (small white spike strip near snout)
  for (let i = 0; i < 5; i++) {
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.08, 4), toothMat);
    t.position.set(-0.1 + i * 0.05, 0.18, -0.65);
    t.rotation.x = Math.PI;
    shark.add(t);
  }

  shark.position.set(x, 0, z);
  shark.userData.health = diff().catHealth;     // reuse difficulty HP
  shark.userData.speed = 2.2 + Math.random() * 0.9;
  shark.userData.attackTimer = Math.random() * 2;
  shark.userData.bobOffset = Math.random() * Math.PI * 2;
  shark.userData.isShark = true;
  shark.userData.hitOffsetY = 0.35;  // mid-body height
  shark.userData.hitRadius = 1.1;    // sharks are long — generous radius

  scene.add(shark);
  ENEMIES.push(shark);
  return shark;
}

// ─── Enemy: Pirate ───────────────────────────────────────────────────────────
function spawnPirate(x, z) {
  const pirate = new THREE.Group();

  const skinMat   = new THREE.MeshStandardMaterial({ color: 0xd8a070, roughness: 0.8 });
  const shirtMat  = new THREE.MeshStandardMaterial({ color: 0xa83030, roughness: 0.7 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xfff0d0, roughness: 0.7 });
  const pantsMat  = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
  const beltMat   = new THREE.MeshStandardMaterial({ color: 0x402a14, roughness: 0.6 });
  const hatMat    = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.6 });
  const swordMat  = new THREE.MeshStandardMaterial({ color: 0xcfd8e0, metalness: 0.7, roughness: 0.3 });
  const eyeMat    = new THREE.MeshBasicMaterial({ color: 0x000000 });

  // Legs
  for (const sx of [-0.18, 0.18]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.7, 0.28), pantsMat);
    leg.position.set(sx, 0.35, 0);
    pirate.add(leg);
  }

  // Body (striped shirt)
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.45), shirtMat);
  body.position.y = 1.15;
  pirate.add(body);
  // Stripes
  for (const ys of [-0.25, 0, 0.25]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.12, 0.46), stripeMat);
    stripe.position.set(0, 1.15 + ys, 0);
    pirate.add(stripe);
  }

  // Belt
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.12, 0.48), beltMat);
  belt.position.y = 0.7;
  pirate.add(belt);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.06), new THREE.MeshStandardMaterial({ color: 0xf0c040, metalness: 0.7 }));
  buckle.position.set(0, 0.7, 0.27);
  pirate.add(buckle);

  // Arms
  for (const sx of [-0.46, 0.46]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.22), shirtMat);
    arm.position.set(sx, 1.2, 0);
    pirate.add(arm);
  }

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), skinMat);
  head.position.y = 1.95;
  pirate.add(head);

  // Beard
  const beardMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 });
  const beard = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), beardMat);
  beard.scale.set(1.0, 0.55, 0.6);
  beard.position.set(0, 1.78, 0.15);
  pirate.add(beard);

  // Eyes
  for (const sx of [-0.1, 0.1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), eyeMat);
    eye.position.set(sx, 2.0, 0.26);
    pirate.add(eye);
  }
  // Eyepatch over right eye
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.12), hatMat);
  patch.position.set(0.1, 2.0, 0.28);
  pirate.add(patch);

  // Pirate hat (wide tricorn = cone scaled flat + brim)
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.08, 16), hatMat);
  brim.position.y = 2.25;
  pirate.add(brim);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.32, 12), hatMat);
  crown.position.y = 2.42;
  pirate.add(crown);
  // Skull on hat
  const skullDot = new THREE.Mesh(new THREE.CircleGeometry(0.08, 12), new THREE.MeshBasicMaterial({ color: 0xfff0d0, side: THREE.DoubleSide }));
  skullDot.position.set(0, 2.42, 0.32);
  pirate.add(skullDot);

  // Cutlass in right hand
  const sword = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.95, 0.02), swordMat);
  blade.position.y = 0.45;
  sword.add(blade);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 8), beltMat);
  sword.add(grip);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.08), swordMat);
  guard.position.y = 0.1;
  sword.add(guard);
  sword.position.set(0.55, 0.95, 0.15);
  sword.rotation.z = -0.3;
  pirate.add(sword);
  pirate.userData.sword = sword;

  pirate.position.set(x, 1.4, z);  // stand on deck (y=1.4 baseline)
  pirate.userData.health = diff().catHealth + 20;   // tougher than cats/sharks
  pirate.userData.speed = 1.6 + Math.random() * 0.5;
  pirate.userData.attackTimer = Math.random() * 2;
  pirate.userData.bobOffset = Math.random() * Math.PI * 2;
  pirate.userData.isPirate = true;
  // Body spans local y≈0.35 (legs) to ≈2.4 (hat). Aim hit-center at the chest.
  pirate.userData.hitOffsetY = 1.2;
  pirate.userData.hitRadius = 1.15;

  scene.add(pirate);
  ENEMIES.push(pirate);
  return pirate;
}

// ─── Input ────────────────────────────────────────────────────────────────────
function onMouseMove(e) {
  if (!MOUSE.locked) return;
  MOUSE.dx += e.movementX;
  MOUSE.dy += e.movementY;
}

function onClick(e) {
  if (!STATE.started || STATE.gameover) return;
  // Only react to clicks on the game canvas — buttons, menus, etc. shouldn't lock the pointer
  if (e && e.target && e.target.id !== 'canvas') return;
  // On touch devices, only the dedicated FIRE button fires; canvas taps do nothing
  if (isTouchDevice()) return;
  if (!MOUSE.locked) {
    lockPointer();
    return;
  }
  throwAmmo();
}

function showPlayHint() {
  const el = document.getElementById('play-hint');
  if (el) el.style.display = 'flex';
}

function hidePlayHint() {
  const el = document.getElementById('play-hint');
  if (el) el.style.display = 'none';
}

function setSpacesuitVisor(on) {
  const el = document.getElementById('visor');
  if (el) el.style.display = on ? 'block' : 'none';
  if (on) {
    const planet = document.getElementById('visor-planet');
    if (planet) planet.textContent = visorPlanetText(STATE.level);
  }
}

function visorPlanetText(level) {
  if (level === 'pluto-surface')   return 'PLUTO • -229°C';
  if (level === 'neptune-surface') return 'NEPTUNE • -201°C';
  if (level === 'uranus-surface')  return 'URANUS • -224°C';
  if (level === 'saturn-surface')  return 'SATURN • -178°C';
  return '— • —';
}

// ─── Player Movement ──────────────────────────────────────────────────────────
function updatePlayer(dt) {
  // If any keyboard movement key is down, treat keyboard as authoritative and
  // zero out any stale touch input (e.g. a touchscreen laptop that registered a
  // ghost touch). Prevents "drifting by itself" complaints on hybrid devices.
  if (KEYS['KeyW'] || KEYS['KeyA'] || KEYS['KeyS'] || KEYS['KeyD'] ||
      KEYS['ArrowUp'] || KEYS['ArrowDown'] || KEYS['ArrowLeft'] || KEYS['ArrowRight']) {
    TOUCH.moveX = 0; TOUCH.moveZ = 0;
    TOUCH.lookX = 0; TOUCH.lookY = 0;
  }

  // Deadzone — ignore tiny stick deflections so accidental touches don't drift the player
  const DEAD = 0.08;
  const tmx = Math.abs(TOUCH.moveX) > DEAD ? TOUCH.moveX : 0;
  const tmz = Math.abs(TOUCH.moveZ) > DEAD ? TOUCH.moveZ : 0;
  const tlx = Math.abs(TOUCH.lookX) > DEAD ? TOUCH.lookX : 0;
  const tly = Math.abs(TOUCH.lookY) > DEAD ? TOUCH.lookY : 0;

  // Touch right-stick deflection ≥ 0.85 also counts as "running" (no shift key on iPad)
  const touchStickMag = Math.sqrt(tmx*tmx + tmz*tmz);
  const touchRunning = TOUCH.active && touchStickMag > 0.85;
  const speed = PLAYER_SPEED * ((KEYS['ShiftLeft'] || KEYS['ShiftRight'] || touchRunning) ? RUN_MULT : 1);

  // Touch right-stick → continuous look rate (feeds the same MOUSE.dx/dy pipeline).
  // Cockpit/flight modes use much slower rates — you're aiming at distant ships with
  // a fixed cockpit frame, so a fast sweep overshoots constantly. Foot levels keep
  // the snappy ~275°/s rate. A x*|x|^0.6 curve keeps small deflections precise.
  if (TOUCH.active && (tlx !== 0 || tly !== 0)) {
    const inFlight = STATE.level === 'space-cockpit'
      || STATE.level === 'neptune-approach'
      || STATE.level === 'saturn-approach';
    const TOUCH_LOOK_RATE_X = inFlight ?  700 : 1600;
    const TOUCH_LOOK_RATE_Y = inFlight ?  500 : 1200;
    const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.6);
    MOUSE.dx += curve(tlx) * TOUCH_LOOK_RATE_X * dt;
    MOUSE.dy += curve(tly) * TOUCH_LOOK_RATE_Y * dt;
  }

  // Mouse look
  const sensitivity = 0.002;
  playerYaw   -= MOUSE.dx * sensitivity;
  playerPitch -= MOUSE.dy * sensitivity;
  playerPitch  = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, playerPitch));
  MOUSE.dx = 0;
  MOUSE.dy = 0;

  // Apply rotation to camera
  camera.rotation.order = 'YXZ';
  camera.rotation.y = playerYaw;
  camera.rotation.x = playerPitch;

  // Movement direction from WASD + touch left-stick (both supported)
  const move = new THREE.Vector3();
  if (KEYS['KeyW'] || KEYS['ArrowUp'])    move.z -= 1;
  if (KEYS['KeyS'] || KEYS['ArrowDown'])  move.z += 1;
  if (KEYS['KeyA'] || KEYS['ArrowLeft'])  move.x -= 1;
  if (KEYS['KeyD'] || KEYS['ArrowRight']) move.x += 1;
  if (TOUCH.active && (tmx !== 0 || tmz !== 0)) {
    move.x += tmx;
    move.z += tmz;
  }
  if (move.lengthSq() > 1) move.normalize();
  move.applyEuler(new THREE.Euler(0, playerYaw, 0));
  move.multiplyScalar(speed * dt);

  // Gravity (simple)
  playerVelocityY += GRAVITY * dt;
  camera.position.y += playerVelocityY * dt;
  if (camera.position.y < PLAYER_HEIGHT) {
    camera.position.y = PLAYER_HEIGHT;
    playerVelocityY = 0;
  }

  // Apply XZ movement with wall collision (simple AABB)
  const next = camera.position.clone().add(move);
  const [WX, WZ] = levelBounds(STATE.level);
  next.x = Math.max(-WX, Math.min(WX, next.x));
  next.z = Math.max(-WZ, Math.min(WZ, next.z));
  camera.position.x = next.x;
  camera.position.z = next.z;

  // Per-level floor adjustments
  if (STATE.level === 'space-cockpit') {
    // Cockpit pilot height — slight side-lean while steering
    camera.position.y = PLAYER_HEIGHT + 0.4;
    playerVelocityY = 0;
  } else if (STATE.level === 'pluto-surface') {
    // Crack-fall hazard
    const crack = isInCrack(camera.position.x, camera.position.z);
    if (crack && !playerState.crackFalling) {
      playerState.crackFalling = true;
      damagePlayer(45);
      showMessage('💀 FELL INTO A CRACK! 💀', 1800);
      // Knock player back along the shortest axis out of the crack
      const cosA = Math.cos(-crack.angle), sinA = Math.sin(-crack.angle);
      const lx = (camera.position.x - crack.x) * cosA - (camera.position.z - crack.z) * sinA;
      const lz = (camera.position.x - crack.x) * sinA + (camera.position.z - crack.z) * cosA;
      // Push out along whichever local axis they're closer to the edge of
      const pushLx = Math.sign(lx || 1) * (crack.halfW + 0.6);
      const pushLz = Math.sign(lz || 1) * (crack.halfL * 0.6);
      const cosB = Math.cos(crack.angle), sinB = Math.sin(crack.angle);
      camera.position.x = crack.x + (pushLx * cosB - pushLz * sinB);
      camera.position.z = crack.z + (pushLx * sinB + pushLz * cosB);
      setTimeout(() => { playerState.crackFalling = false; }, 600);
    }
  } else if (STATE.level === 'ocean-surface') {
    // Raise camera to deck height when on the boat footprint
    const onBoat = Math.abs(camera.position.x) < 2.3 && camera.position.z > -4.5 && camera.position.z < 4.5;
    const onRamp = Math.abs(camera.position.x) < 1.1 && camera.position.z >= 4.5 && camera.position.z < 7.5;
    let floorY = PLAYER_HEIGHT;
    if (onBoat) floorY = PLAYER_HEIGHT + 1.35;
    else if (onRamp) {
      const t = (camera.position.z - 7.5) / (4.5 - 7.5);
      floorY = PLAYER_HEIGHT + 1.35 * Math.max(0, Math.min(1, t));
    }
    if (camera.position.y < floorY) { camera.position.y = floorY; playerVelocityY = 0; }
  } else if (STATE.level === 'pirate-ship') {
    // Player stands on the deck (raised platform)
    const deckY = PLAYER_HEIGHT + 1.4;
    if (camera.position.y < deckY) { camera.position.y = deckY; playerVelocityY = 0; }
  } else if (STATE.level === 'ocean-underwater') {
    // Slow gentle bob — player is "swimming" but still walks on seafloor
    camera.position.y = PLAYER_HEIGHT + Math.sin(clock.getElapsedTime() * 1.2) * 0.08;
    playerVelocityY = 0;
  }

  // Arm bob
  if (move.length() > 0.001 && dogArm) {
    const t = clock.getElapsedTime();
    dogArm.position.y = -0.28 + Math.sin(t * ARM_BOB_SPEED) * 0.015;
    dogArm.position.x = 0.3 + Math.sin(t * ARM_BOB_SPEED * 0.5) * 0.005;
  }

  // Space to throw (keyboard)
  if (KEYS['Space']) {
    KEYS['Space'] = false;
    throwAmmo();
  }
}

// ─── Update Projectiles ───────────────────────────────────────────────────────
function updateProjectiles(dt) {
  const inSpace = isSpaceLike(STATE.level);
  for (let i = PROJECTILES.length - 1; i >= 0; i--) {
    const p = PROJECTILES[i];
    p.userData.lifetime -= dt;
    p.position.addScaledVector(p.userData.velocity, dt);
    if (!p.userData.isLaser && !p.userData.isMissile && !p.userData.isNail) {
      p.rotation.x += dt * 5;
      p.rotation.z += dt * 3;
      // Apply gravity to bone/diamond arc (lasers/missiles/nails travel straight)
      p.userData.velocity.y -= 4 * dt;
    }
    // Missile exhaust trail flicker
    if (p.userData.isMissile && p.userData.exhaust) {
      p.userData.exhaust.scale.setScalar(0.9 + Math.random() * 0.4);
    }

    // Remove if expired or out of bounds
    let outOfBounds;
    if (inSpace) {
      // Wide envelope: lasers travel far in space
      outOfBounds = p.userData.lifetime <= 0 ||
        Math.abs(p.position.x) > 60 ||
        Math.abs(p.position.y) > 40 ||
        p.position.z < -200 || p.position.z > 20;
    } else {
      const [BX, BZ] = levelBounds(STATE.level);
      const yFloor = STATE.level === 'ocean-underwater' ? -3 : -0.5;
      outOfBounds = p.userData.lifetime <= 0 ||
        Math.abs(p.position.x) > BX + 2 ||
        Math.abs(p.position.z) > BZ + 2 ||
        p.position.y < yFloor;
    }
    if (outOfBounds) {
      scene.remove(p);
      PROJECTILES.splice(i, 1);
      continue;
    }

    // Check enemy hits — reuse SCRATCH vectors instead of allocating per frame.
    const prev = SCRATCH.vA.set(
      p.position.x - p.userData.velocity.x * dt,
      p.position.y - p.userData.velocity.y * dt,
      p.position.z - p.userData.velocity.z * dt,
    );
    let consumed = false;
    for (let j = ENEMIES.length - 1; j >= 0; j--) {
      const enemy = ENEMIES[j];
      if (enemy.userData.isBoss) {
        const weak = enemy.userData.weakPoint;
        if (!weak) continue;
        const wPos = weak.getWorldPosition(SCRATCH.vB);
        const wr = enemy.userData.weakRadius || 2.4;
        const tt = segmentSphereHit(prev, p.position, wPos, wr);
        if (tt === null) continue;
        const hitPos = SCRATCH.vC.copy(prev).lerp(p.position, tt);
        enemy.userData.health -= p.userData.damage;
        spawnBossSparks(hitPos, 0xffe060);
        spawnDamageNumber(hitPos, p.userData.damage, '#80ff80');
        flashHitVignette();
        updateBossHud(enemy);
        if (enemy.userData.health <= 0) triggerBossDeath(j);
        else                            flashWeakPoint(enemy);
        scene.remove(p);
        PROJECTILES.splice(i, 1);
        consumed = true;
        break;
      }
      // Regular enemies — use segment-sphere for fast projectiles (lasers/missiles/
      // nails travel >50 m/s and can skip past targets at low FPS otherwise).
      // Bones/diamonds/dirt fall back to the cheaper point-in-sphere check.
      const hitY = enemy.position.y + (enemy.userData.hitOffsetY || 0.4);
      const r = enemy.userData.hitRadius || 0.85;
      const fast = p.userData.isLaser || p.userData.isMissile || p.userData.isNail;
      let hit = false;
      if (fast) {
        const enemyCenter = SCRATCH.vD.set(enemy.position.x, hitY, enemy.position.z);
        hit = segmentSphereHit(prev, p.position, enemyCenter, r) !== null;
      } else {
        const dx = p.position.x - enemy.position.x;
        const dy = p.position.y - hitY;
        const dz = p.position.z - enemy.position.z;
        hit = dx*dx + dy*dy + dz*dz < r * r;
      }
      if (hit) {
        if (p.userData.isMissile) {
          // Missiles explode on impact with splash damage
          explodeMissile(p, p.position.clone());
        } else {
          enemy.userData.health -= p.userData.damage;
          // Water-gun aliens: first nail hit visibly shatters the gun
          if (enemy.userData.isWaterAlien && !enemy.userData.gunBroken) {
            breakWaterGun(enemy, p.position.clone());
          }
          if (enemy.userData.health <= 0) killEnemy(j);
          else                            flashEnemy(enemy);
        }
        scene.remove(p);
        PROJECTILES.splice(i, 1);
        consumed = true;
        break;
      }
    }
    if (consumed) continue;
  }
}

function breakWaterGun(alien, hitPos) {
  alien.userData.gunBroken = true;
  const gun = alien.userData.gun;
  if (!gun) return;
  // Eject each piece with random velocity so they tumble away (just visual debris)
  const pieces = alien.userData.gunPieces || [];
  for (const piece of pieces) {
    // World position of the piece
    const wp = new THREE.Vector3();
    piece.getWorldPosition(wp);
    gun.remove(piece);
    piece.position.copy(wp);
    scene.add(piece);
    piece.userData.life = 1.5;
    piece.userData.vel = new THREE.Vector3(
      (Math.random() - 0.5) * 4,
      Math.random() * 4 + 2,
      (Math.random() - 0.5) * 4,
    );
    scene.userData.particles = scene.userData.particles || [];
    scene.userData.particles.push(piece);
  }
  // Remove the (now mostly empty) gun group
  alien.remove(gun);
  alien.userData.gun = null;
  // Brief flash of water spurting out
  for (let k = 0; k < 10; k++) spawnBossSparks(hitPos, 0x60c8ff);
  showMessage('GUN BROKEN! KEEP NAILING THEM! 🔨', 1100);
}

// Returns the t in [0,1] where the segment p0→p1 enters the sphere, or null if it doesn't.
function segmentSphereHit(p0, p1, center, radius) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const mx = p0.x - center.x, my = p0.y - center.y, mz = p0.z - center.z;
  const a = dx*dx + dy*dy + dz*dz;
  if (a < 1e-8) {
    // Degenerate segment — fall back to point check
    return (mx*mx + my*my + mz*mz < radius * radius) ? 0 : null;
  }
  const b = 2 * (mx*dx + my*dy + mz*dz);
  const c = mx*mx + my*my + mz*mz - radius * radius;
  if (c < 0) return 0;   // p0 already inside sphere
  const disc = b*b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1) return null;
  return t;
}

function flashWeakPoint(boss) {
  const weak = boss.userData.weakPoint;
  const halo = boss.userData.weakHalo;
  const light = boss.userData.weakLight;
  if (!weak) return;

  // Bright white flash on the weak point
  const origColor = 0xff2030;
  weak.material.color.setHex(0xffffff);
  // Pop the weak point bigger briefly
  weak.scale.setScalar(1.35);
  if (halo) {
    halo.material.opacity = 1.0;
    halo.scale.setScalar(1.8);
    halo.material.color.setHex(0xffe080);
  }
  if (light) {
    light.intensity = 9.0;
    light.color.setHex(0xfff0a0);
  }

  let elapsed = 0;
  const decay = () => {
    elapsed += 16;
    const k = Math.max(0, 1 - elapsed / 260);
    weak.scale.setScalar(1 + 0.35 * k);
    if (halo) {
      halo.scale.setScalar(1 + 0.8 * k);
      halo.material.opacity = 0.65 + 0.35 * k;
    }
    if (elapsed < 260) requestAnimationFrame(decay);
    else {
      weak.material.color.setHex(origColor);
      weak.scale.setScalar(1);
      if (halo) {
        halo.material.color.setHex(0xff4040);
        halo.material.opacity = 0.7;
        halo.scale.setScalar(1);
      }
      if (light) {
        light.color.setHex(0xff4040);
      }
    }
  };
  requestAnimationFrame(decay);
}

// Brief green-tinted edge flash on the HUD when the player lands a weak-point hit
function flashHitVignette() {
  const el = document.getElementById('hit-vignette');
  if (!el) return;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 180);
}

// Floating damage number that drifts up from the boss
function spawnDamageNumber(worldPos, amount, color = '#80ff80') {
  const el = document.createElement('div');
  el.textContent = amount > 0 ? `-${amount}` : 'DEFLECT';
  el.style.cssText = `position:fixed; color:${color}; font-family:'Courier New',monospace; font-size:22px; font-weight:bold; text-shadow:0 0 8px ${color}, 0 0 2px #000; letter-spacing:2px; pointer-events:none; z-index:55; transition:transform 0.9s linear, opacity 0.9s linear; transform:translate(-50%, -50%);`;
  // Project world → screen
  const v = worldPos.clone().project(camera);
  const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
  el.style.left = sx + 'px';
  el.style.top  = sy + 'px';
  document.body.appendChild(el);
  // Animate up + fade
  requestAnimationFrame(() => {
    el.style.transform = 'translate(-50%, -180%)';
    el.style.opacity = '0';
  });
  setTimeout(() => el.remove(), 950);
}

function spawnBossSparks(pos, color) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.07, 5, 4), mat.clone());
    p.position.copy(pos).add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.3,
      (Math.random() - 0.5) * 0.3,
      (Math.random() - 0.5) * 0.3,
    ));
    p.userData.vel = new THREE.Vector3(
      (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 3 + 1,
      (Math.random() - 0.5) * 3,
    );
    p.userData.life = 0.6;
    scene.add(p);
    scene.userData.particles = scene.userData.particles || [];
    scene.userData.particles.push(p);
  }
}

function updateBossHud(boss) {
  const bar = document.getElementById('boss-fill');
  if (bar) bar.style.width = Math.max(0, (boss.userData.health / boss.userData.maxHealth) * 100) + '%';
}

function triggerBossDeath(index) {
  const boss = ENEMIES[index];
  // Big explosion of sparks centered on weak point
  const wPos = new THREE.Vector3();
  if (boss.userData.weakPoint) boss.userData.weakPoint.getWorldPosition(wPos);
  else wPos.copy(boss.position);
  for (let k = 0; k < 5; k++) spawnBossSparks(wPos, k % 2 ? 0xffa040 : 0xffe060);
  scene.remove(boss);
  ENEMIES.splice(index, 1);
  scene.userData.boss = null;
  // Hide boss HP bar
  const wrap = document.getElementById('boss-bar-wrap');
  if (wrap) wrap.style.display = 'none';
  // Begin safe landing on Neptune
  scene.userData.spacePhase = 'approach';
  showMessage('BOSS DOWN! SAFE LANDING ON NEPTUNE… 🪐', 4000);
}

function updateEnemyProjectiles(dt) {
  for (let i = ENEMY_PROJECTILES.length - 1; i >= 0; i--) {
    const p = ENEMY_PROJECTILES[i];
    p.userData.lifetime -= dt;
    p.position.addScaledVector(p.userData.velocity, dt);

    // Hit player? (camera position is player position)
    const dx = p.position.x - camera.position.x;
    const dy = p.position.y - camera.position.y;
    const dz = p.position.z - camera.position.z;
    if (dx*dx + dy*dy + dz*dz < 0.7 * 0.7) {
      damagePlayer(p.userData.damage);
      scene.remove(p);
      ENEMY_PROJECTILES.splice(i, 1);
      continue;
    }

    if (p.userData.lifetime <= 0 || p.position.length() > 200) {
      scene.remove(p);
      ENEMY_PROJECTILES.splice(i, 1);
    }
  }
}

function flashEnemy(enemy) {
  const originalColor = 0x2a1a3a;
  enemy.traverse(child => {
    if (child.isMesh && child.material.color) {
      child.material.color.setHex(0xff4444);
    }
  });
  setTimeout(() => {
    enemy.traverse(child => {
      if (child.isMesh && child.material.color) {
        child.material.color.setHex(originalColor);
      }
    });
  }, 120);
}

function killEnemy(index) {
  const enemy = ENEMIES[index];
  spawnDeathParticles(enemy.position.clone());
  scene.remove(enemy);
  ENEMIES.splice(index, 1);
  if (isSpaceLike(STATE.level)) {
    STATE.lasers = Math.min(STATE.lasers + 6, 60);
    updateHUD();
    showMessage('+6 LASERS!', 1500);
  } else if (isOceanLike(STATE.level)) {
    STATE.diamonds = Math.min(STATE.diamonds + 4, 40);
    updateHUD();
    showMessage('+4 DIAMONDS!', 1500);
  } else {
    STATE.bones = Math.min(STATE.bones + 5, 40);
    updateHUD();
    showMessage('+5 BONES!', 1500);
  }
}

function spawnDeathParticles(pos) {
  const particleMat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
  for (let i = 0; i < 12; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.06, 4, 3), particleMat);
    p.position.copy(pos).add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.5,
      Math.random() * 0.5,
      (Math.random() - 0.5) * 0.5
    ));
    p.userData.vel = new THREE.Vector3(
      (Math.random() - 0.5) * 4,
      Math.random() * 5 + 2,
      (Math.random() - 0.5) * 4
    );
    p.userData.life = 0.8;
    scene.add(p);
    scene.userData.particles = scene.userData.particles || [];
    scene.userData.particles.push(p);
  }
}

// ─── Bone Pickups ─────────────────────────────────────────────────────────────
const pickupBoneMat = persistMat(new THREE.MeshStandardMaterial({
  color: 0xf5e8c0,
  roughness: 0.6,
  emissive: 0xffe090,
  emissiveIntensity: 0.25,
}));

function spawnBonePickups(count) {
  for (let i = 0; i < count; i++) {
    const group = new THREE.Group();
    // Shaft
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.4, 8), pickupBoneMat);
    shaft.rotation.z = Math.PI / 3;
    group.add(shaft);
    // Knobs
    for (const s of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const ang = (k / 2) * Math.PI / 2;
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.08, 7, 5), pickupBoneMat);
        knob.position.set(
          s * 0.22 + Math.cos(ang + Math.PI/3) * 0.05,
          s * 0.22 + Math.sin(ang + Math.PI/3) * 0.05,
          0
        );
        group.add(knob);
      }
    }
    // Bone glows via its emissive material — no per-pickup PointLight needed.
    // (Each light forces all lit materials' shaders to recompile, and 6+ bones
    // at scene start was a major contributor to dungeon stutter.)

    // Random floor position (away from walls and center)
    let px, pz;
    do {
      px = (Math.random() - 0.5) * 16;
      pz = (Math.random() - 0.5) * 16;
    } while (Math.sqrt(px*px + pz*pz) < 2);

    group.position.set(px, 0.3, pz);
    group.userData.bobBase = 0.3;
    group.userData.rotOffset = Math.random() * Math.PI * 2;
    scene.add(group);
    BONE_PICKUPS.push(group);
  }
}

function updateBonePickups(dt) {
  const t = clock.getElapsedTime();
  for (let i = BONE_PICKUPS.length - 1; i >= 0; i--) {
    const b = BONE_PICKUPS[i];
    // Hover and spin
    b.position.y = b.userData.bobBase + Math.sin(t * 2.5 + b.userData.rotOffset) * 0.12;
    b.rotation.y += dt * 2.0;

    // Pickup collision with player
    const dx = b.position.x - camera.position.x;
    const dz = b.position.z - camera.position.z;
    if (Math.sqrt(dx*dx + dz*dz) < 0.9) {
      STATE.bones = Math.min(STATE.bones + 3, 40);
      updateHUD();
      showMessage('+3 BONES!', 1000);
      scene.remove(b);
      BONE_PICKUPS.splice(i, 1);
    }
  }
}

// ─── Diamond Pickups ─────────────────────────────────────────────────────────
function spawnDiamondPickups(count) {
  for (let i = 0; i < count; i++) {
    const group = new THREE.Group();
    const gem = makeDiamondMesh(1.4);
    group.add(gem);

    // Outer glow shell
    const shellMat = new THREE.MeshBasicMaterial({
      color: 0x7fe9ff,
      transparent: true,
      opacity: 0.14,
      side: THREE.BackSide,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 7), shellMat);
    group.add(shell);

    const glow = new THREE.PointLight(0x7fe9ff, 1.0, 5, 2);
    group.add(glow);
    group.userData.glow = glow;
    group.userData.shell = shell;

    // Place within current level's playable bounds
    let px, pz, py;
    if (STATE.level === 'pirate-ship') {
      // On the deck
      px = (Math.random() - 0.5) * 7.2;
      pz = -10 + Math.random() * 22;     // -10..12 along the deck length
      py = 1.7;                          // floats above deck
    } else if (STATE.level === 'ocean-underwater') {
      do {
        px = (Math.random() - 0.5) * 36;
        pz = (Math.random() - 0.5) * 36;
      } while (px*px + pz*pz < 16);
      py = 0.5 + Math.random() * 1.8;    // various heights in the water
    } else {
      // ocean-surface (or fallback)
      do {
        px = (Math.random() - 0.5) * 28;
        pz = (Math.random() - 0.5) * 28;
      } while (
        (Math.abs(px) < 4 && Math.abs(pz) < 6.5) ||  // avoid boat
        (px*px + pz*pz) < 9                          // not too close to player spawn
      );
      py = 0.55;
    }

    group.position.set(px, py, pz);
    group.userData.bobBase = py;
    group.userData.rotOffset = Math.random() * Math.PI * 2;
    scene.add(group);
    DIAMOND_PICKUPS.push(group);
  }
}

function updateDiamondPickups(dt) {
  const t = clock.getElapsedTime();
  for (let i = DIAMOND_PICKUPS.length - 1; i >= 0; i--) {
    const d = DIAMOND_PICKUPS[i];
    d.position.y = d.userData.bobBase + Math.sin(t * 2.5 + d.userData.rotOffset) * 0.14;
    d.rotation.y += dt * 2.5;
    const pulse = 0.5 + Math.sin(t * 5 + d.userData.rotOffset) * 0.5;
    if (d.userData.glow) d.userData.glow.intensity = 0.6 + pulse * 1.2;
    if (d.userData.shell) d.userData.shell.material.opacity = 0.08 + pulse * 0.12;

    const dx = d.position.x - camera.position.x;
    const dz = d.position.z - camera.position.z;
    if (Math.sqrt(dx*dx + dz*dz) < 0.9) {
      STATE.diamonds = Math.min(STATE.diamonds + 3, 40);
      updateHUD();
      showMessage('+3 DIAMONDS!', 1000);
      scene.remove(d);
      DIAMOND_PICKUPS.splice(i, 1);
    }
  }
}

// ─── Health Pickups (Dog Treats) ──────────────────────────────────────────────
function spawnTreatPickups(count) {
  for (let i = 0; i < count; i++) {
    const group = new THREE.Group();

    // Meaty orange dog-treat — a chunky drumstick/biscuit shape
    const meatMat = new THREE.MeshStandardMaterial({
      color: 0xff7a1a,
      emissive: 0xff5a00,
      emissiveIntensity: 0.75,
      roughness: 0.55,
    });
    const boneEndMat = new THREE.MeshStandardMaterial({
      color: 0xfff0c8,
      emissive: 0xffd080,
      emissiveIntensity: 0.4,
      roughness: 0.6,
    });

    // Meaty body (squashed sphere = drumstick)
    const meat = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 9), meatMat);
    meat.scale.set(1.0, 0.85, 1.0);
    group.add(meat);

    // Little bone nub sticking out one side
    const nub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 8), boneEndMat);
    nub.rotation.z = Math.PI / 2;
    nub.position.set(0.32, 0, 0);
    group.add(nub);
    const nubCap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), boneEndMat);
    nubCap.position.set(0.44, 0, 0);
    group.add(nubCap);

    // Outer glow shell (warm orange)
    const glowShellMat = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0.14,
      side: THREE.BackSide,
    });
    const glowShell = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), glowShellMat);
    group.add(glowShell);

    // Tall beacon beam (warm orange)
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 5.5, 8), beamMat);
    beam.position.y = 2.75;
    group.add(beam);

    // Warm orange point light
    const glow = new THREE.PointLight(0xffaa44, 3.0, 7, 1.5);
    group.add(glow);
    group.userData.glow = glow;
    group.userData.glowShell = glowShell;

    let px, pz, py = 0.55;
    if (STATE.level === 'pirate-ship') {
      px = (Math.random() - 0.5) * 7.2;
      pz = -10 + Math.random() * 22;
      py = 1.7;
    } else if (STATE.level === 'ocean-underwater') {
      do {
        px = (Math.random() - 0.5) * 32;
        pz = (Math.random() - 0.5) * 32;
      } while (Math.sqrt(px*px + pz*pz) < 4);
      py = 0.5;
    } else if (STATE.level === 'ocean-surface') {
      do {
        px = (Math.random() - 0.5) * 24;
        pz = (Math.random() - 0.5) * 24;
      } while (Math.abs(px) < 4 && Math.abs(pz) < 6.5);
      py = 0.55;
    } else {
      do {
        px = (Math.random() - 0.5) * 14;
        pz = (Math.random() - 0.5) * 14;
      } while (Math.sqrt(px*px + pz*pz) < 2);
      py = 0.55;
    }

    group.position.set(px, py, pz);
    group.userData.bobBase = py;
    group.userData.rotOffset = Math.random() * Math.PI * 2;
    scene.add(group);
    TREAT_PICKUPS.push(group);
  }
}

function updateTreatPickups(dt) {
  const t = clock.getElapsedTime();
  for (let i = TREAT_PICKUPS.length - 1; i >= 0; i--) {
    const tr = TREAT_PICKUPS[i];
    tr.position.y = tr.userData.bobBase + Math.sin(t * 3 + tr.userData.rotOffset) * 0.14;
    tr.rotation.y += dt * 2.0;
    const pulse = 0.5 + Math.sin(t * 5 + tr.userData.rotOffset) * 0.5;
    if (tr.userData.glow) {
      tr.userData.glow.intensity = 2.5 + pulse * 2.5;
    }
    if (tr.userData.glowShell) {
      tr.userData.glowShell.material.opacity = 0.06 + pulse * 0.14;
    }

    const dx = tr.position.x - camera.position.x;
    const dz = tr.position.z - camera.position.z;
    if (Math.sqrt(dx*dx + dz*dz) < 0.9) {
      const heal = diff().treatHeal;
      const gained = Math.min(heal, 100 - STATE.health);
      STATE.health = Math.min(100, STATE.health + heal);
      updateHUD();
      showMessage(gained > 0 ? `+${gained} HP! GOOD BOY!` : 'HEALTH FULL!', 1500);
      scene.remove(tr);
      TREAT_PICKUPS.splice(i, 1);
    }
  }
}

// ─── Space Pickups (health packs + laser ammo packs) ─────────────────────────
const SPACE_PICKUPS = [];
const DIRT_PICKUPS = [];
const NAIL_PICKUPS = [];
const saturnWind = { dirX: 1, dirZ: 0, mag: 0, phase: 0, gustTimer: 0 };

// Build a red-cross medkit mesh. Used by both the scrolling space-pickup and the
// ground-placed Saturn medkit (so the player on Saturn doesn't see bone-nubbed treats).
function makeMedkitMesh() {
  const g = new THREE.Group();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.45, 0.45),
    new THREE.MeshStandardMaterial({ color: 0xf0f0f0, emissive: 0x404040, emissiveIntensity: 0.4, roughness: 0.4 })
  );
  g.add(box);
  const crossMat = new THREE.MeshBasicMaterial({ color: 0xff2244 });
  for (const face of [
    { pos: [0, 0,  0.235], rot: [0, 0, 0] },
    { pos: [0, 0, -0.235], rot: [0, Math.PI, 0] },
    { pos: [ 0.235, 0, 0], rot: [0, Math.PI/2, 0] },
    { pos: [-0.235, 0, 0], rot: [0, -Math.PI/2, 0] },
  ]) {
    const v = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.12), crossMat);
    v.position.set(...face.pos); v.rotation.set(...face.rot); g.add(v);
    const h = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.36), crossMat);
    h.position.set(...face.pos); h.rotation.set(...face.rot); g.add(h);
  }
  return g;
}

// Ground-placed medkits — hover/spin, heal like treats. Pushed into TREAT_PICKUPS
// so updateTreatPickups handles the collision/heal logic.
function spawnGroundMedkits(count) {
  for (let i = 0; i < count; i++) {
    const group = new THREE.Group();
    const kit = makeMedkitMesh();
    kit.scale.setScalar(0.85);
    group.add(kit);
    const glow = new THREE.PointLight(0xff4060, 1.6, 4.5, 2);
    glow.position.y = 0.2;
    group.add(glow);
    group.userData.glow = glow;
    group.userData.isMedkit = true;

    let px, pz;
    do {
      px = (Math.random() - 0.5) * 38;
      pz = (Math.random() - 0.5) * 38;
    } while (px*px + pz*pz < 6);
    group.position.set(px, 0.55, pz);
    group.userData.bobBase = 0.55;
    group.userData.rotOffset = Math.random() * Math.PI * 2;
    scene.add(group);
    TREAT_PICKUPS.push(group);
  }
}

function spawnSpaceHealthPacks(count) {
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group();
    // Red cross health pack — white box with red cross
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.45, 0.45),
      new THREE.MeshStandardMaterial({ color: 0xf0f0f0, emissive: 0x404040, emissiveIntensity: 0.4, roughness: 0.4 })
    );
    g.add(box);
    const crossMat = new THREE.MeshBasicMaterial({ color: 0xff2244 });
    for (const face of [
      { pos: [0, 0,  0.235], rot: [0, 0, 0] },
      { pos: [0, 0, -0.235], rot: [0, Math.PI, 0] },
      { pos: [ 0.235, 0, 0], rot: [0, Math.PI/2, 0] },
      { pos: [-0.235, 0, 0], rot: [0, -Math.PI/2, 0] },
    ]) {
      const v = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.12), crossMat);
      v.position.set(...face.pos); v.rotation.set(...face.rot); g.add(v);
      const h = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.36), crossMat);
      h.position.set(...face.pos); h.rotation.set(...face.rot); g.add(h);
    }
    const glow = new THREE.PointLight(0xff4060, 1.4, 4, 2);
    g.add(glow);
    g.userData.glow = glow;
    g.userData.isHealthPack = true;
    g.userData.heal = 35;
    placeSpacePickup(g);
    SPACE_PICKUPS.push(g);
    scene.add(g);
  }
}

function spawnSpaceLaserPacks(count) {
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.25, 0),
      new THREE.MeshStandardMaterial({
        color: 0x60ffff, emissive: 0x40e0ff, emissiveIntensity: 1.8,
        metalness: 0.6, roughness: 0.2,
      })
    );
    core.scale.y = 1.5;
    g.add(core);
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 7),
      new THREE.MeshBasicMaterial({ color: 0x60ffff, transparent: true, opacity: 0.16, side: THREE.BackSide })
    );
    g.add(shell);
    const glow = new THREE.PointLight(0x60ffff, 1.6, 4, 2);
    g.add(glow);
    g.userData.glow = glow;
    g.userData.shell = shell;
    g.userData.isLaserPack = true;
    g.userData.lasers = 12;
    placeSpacePickup(g);
    SPACE_PICKUPS.push(g);
    scene.add(g);
  }
}

function placeSpacePickup(g) {
  // Float far ahead in a corridor the cockpit can steer to reach.
  // Cockpit steering range is ±1.4 (x); ±0.4 (z) — keep x within ±2 so player can reach.
  g.position.set(
    (Math.random() - 0.5) * 4,
    (Math.random() - 0.5) * 1.6 + 1.4,    // camera at y≈1.5, keep near eye level
    -30 - Math.random() * 80,
  );
  g.userData.bobPhase = Math.random() * Math.PI * 2;
  g.userData.scrollSpeed = 6 + Math.random() * 3;
}

function updateSpacePickups(dt) {
  if (!isSpaceLike(STATE.level)) return;
  const t = clock.getElapsedTime();
  for (let i = SPACE_PICKUPS.length - 1; i >= 0; i--) {
    const p = SPACE_PICKUPS[i];
    // Scroll toward player
    p.position.z += p.userData.scrollSpeed * dt;
    // Subtle drift + spin
    p.position.y += Math.sin(t * 1.5 + p.userData.bobPhase) * dt * 0.3;
    p.rotation.y += dt * 2.0;
    p.rotation.x += dt * 0.7;
    if (p.userData.glow) {
      p.userData.glow.intensity = 1.2 + Math.sin(t * 4 + p.userData.bobPhase) * 0.6;
    }

    // Recycle if it scrolls past the player
    if (p.position.z > 4) {
      placeSpacePickup(p);
      continue;
    }

    // Pickup if close to camera
    const dx = p.position.x - camera.position.x;
    const dy = p.position.y - camera.position.y;
    const dz = p.position.z - camera.position.z;
    if (dx*dx + dy*dy + dz*dz < 1.0 * 1.0) {
      if (p.userData.isHealthPack) {
        const gained = Math.min(p.userData.heal, 100 - STATE.health);
        STATE.health = Math.min(100, STATE.health + p.userData.heal);
        updateHUD();
        showMessage(gained > 0 ? `+${gained} HP! GOOD BOY!` : 'HULL FULL!', 1400);
      } else if (p.userData.isLaserPack) {
        STATE.lasers = Math.min(STATE.lasers + p.userData.lasers, 60);
        updateHUD();
        showMessage(`+${p.userData.lasers} LASERS!`, 1400);
      } else if (p.userData.isMissilePack) {
        STATE.missiles = Math.min(STATE.missiles + p.userData.missiles, 12);
        updateHUD();
        showMessage(`+${p.userData.missiles} MISSILES!`, 1400);
      }
      scene.remove(p);
      SPACE_PICKUPS.splice(i, 1);
    }
  }
}

// ─── Space-level progression & landing sequences ─────────────────────────────
function updateSpaceProgress(dt) {
  if (!isSpaceLike(STATE.level)) return;
  const planet = scene.userData.pluto;
  const charon = scene.userData.charon;
  if (!planet) return;

  const phase = scene.userData.spacePhase;
  const target = scene.userData.spaceTarget;   // 'neptune' | 'saturn' | undefined (Pluto)

  // Movement: planet inches in during fight, surges in during approach
  let dz;
  if (phase === 'fight')         dz = target === 'neptune' ? 0.05 : 0.25;
  else if (phase === 'approach') dz = target === 'neptune' ? 12.0 : 16.0;
  else                            dz = 0;
  planet.position.z += dz * dt;
  if (charon) charon.position.z += dz * dt;
  planet.rotation.y += dt * 0.05;

  // Grow planet as it gets closer
  const dist = -planet.position.z;
  const baseDist = 160;
  const scale = Math.max(1, baseDist / Math.max(dist, 4));
  planet.scale.setScalar(scale);

  // Trigger landing when planet is on top of the cockpit
  if (phase === 'approach' && dist < 8 && !transitioning) {
    if (target === 'neptune')      triggerNeptuneLanding();
    else if (target === 'saturn')  triggerSaturnCrash();
    else                            triggerPlutoCrash();
  }
}

function triggerSaturnCrash() {
  transitioning = true;
  scene.userData.spacePhase = 'crash';
  document.exitPointerLock();
  showMessage('CRASHING INTO SATURN\'S STORM!!! 🪐💥', 2800);

  // Stronger shake than Pluto — Saturn's deep atmosphere
  const startY = camera.position.y;
  const shakeStart = performance.now();
  const shake = () => {
    const tt = (performance.now() - shakeStart) / 1800;
    if (tt < 1) {
      const mag = (1 - tt) * 0.45;
      camera.position.y = startY + (Math.random() - 0.5) * mag;
      camera.position.x = (Math.random() - 0.5) * mag;
      requestAnimationFrame(shake);
    }
  };
  requestAnimationFrame(shake);

  // Amber-red flash, then drop into Saturn's surface storm
  const overlay = document.getElementById('transition-overlay');
  overlay.style.background = '#c84020';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.opacity = '1'; }, 1300);
  setTimeout(() => {
    overlay.style.background = '#000';   // reset for loadNextRoom's own fade
    transitioning = false;
    loadNextRoom();                       // → room 13 = saturn-surface
  }, 2200);
}

function triggerJupiterArrival() {
  transitioning = true;
  document.exitPointerLock();
  showMessage('JUPITER PORTAL ENGAGED! 🌀', 2200);
  const overlay = document.getElementById('transition-overlay');
  overlay.style.background = '#ffa040';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.opacity = '1'; }, 700);
  setTimeout(() => {
    overlay.style.background = '#000';   // reset for loadNextRoom's own fade
    transitioning = false;
    loadNextRoom();                       // → room 14 = jupiter-surface
  }, 1700);
}

function triggerJupiterDig() {
  transitioning = true;
  document.exitPointerLock();
  showMessage('DIGGING DOWN INTO JUPITER… ⛏️', 2600);

  // Camera descends into the dig spot (simulated by dropping camera y over ~1.5s)
  const start = performance.now();
  const startY = camera.position.y;
  const drop = () => {
    const tt = Math.min(1, (performance.now() - start) / 1500);
    camera.position.y = startY - tt * 4.5;     // sink ~4.5m below surface
    camera.rotation.x = -tt * 0.6;             // tilt head down as we sink
    if (tt < 1) requestAnimationFrame(drop);
  };
  requestAnimationFrame(drop);

  // Brief orange flash (lava-light through cracks), then portal flash white, then cat ship
  const overlay = document.getElementById('transition-overlay');
  overlay.style.background = '#ff8030';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.opacity = '1'; }, 1300);
  setTimeout(() => {
    overlay.style.background = '#e0d0ff';      // portal flash
  }, 1900);
  setTimeout(() => {
    overlay.style.background = '#000';         // reset for loadNextRoom's own fade
    transitioning = false;
    loadNextRoom();                            // → room 15 = cat-ship-hijack
  }, 2400);
}

function triggerNeptuneLanding() {
  transitioning = true;
  scene.userData.spacePhase = 'crash';
  document.exitPointerLock();
  showMessage('TOUCHING DOWN ON NEPTUNE… 🪐', 2800);

  // Soft landing: gentle blue overlay, then disembark onto the surface
  const overlay = document.getElementById('transition-overlay');
  overlay.style.background = '#3060a0';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.opacity = '1'; }, 1200);
  setTimeout(() => {
    // Award reward for clearing the boss
    STATE.diamonds = Math.min(STATE.diamonds + 20, 99);
    updateHUD();
    overlay.style.background = '#000';   // reset for loadNextRoom's own fade
    transitioning = false;                // loadNextRoom will set this itself
    loadNextRoom();                       // → room 10 = neptune-surface
  }, 2200);
}

function launchPlutoRocket() {
  transitioning = true;
  document.exitPointerLock();
  showMessage('🚀 LIFTOFF! NEXT STOP: NEPTUNE 🚀', 3000);

  const rocket = scene.userData.rocket;
  const startY = rocket ? rocket.position.y : 0;
  const startT = performance.now();
  const lift = () => {
    const tt = (performance.now() - startT) / 1500;
    if (rocket) {
      rocket.position.y = startY + tt * tt * 25;     // accelerate upward
      if (rocket.userData.flame) {
        rocket.userData.flame.scale.y = 1 + Math.sin(tt * 30) * 0.4 + tt * 2;
      }
    }
    if (tt < 1) requestAnimationFrame(lift);
  };
  requestAnimationFrame(lift);

  // After liftoff, fade to black and load Neptune approach
  const overlay = document.getElementById('transition-overlay');
  overlay.style.background = '#000';
  setTimeout(() => { overlay.style.opacity = '1'; }, 800);
  setTimeout(() => {
    transitioning = false;
    loadNextRoom();    // → room 9 = neptune-approach
  }, 1700);
}

function triggerPlutoCrash() {
  transitioning = true;
  scene.userData.spacePhase = 'crash';
  document.exitPointerLock();
  showMessage('CRASH LANDING ON PLUTO!!! 🪐💥', 2800);

  // Screen shake via small camera offset
  const startY = camera.position.y;
  const shakeStart = performance.now();
  const shake = () => {
    const t = (performance.now() - shakeStart) / 1500;
    if (t < 1) {
      const mag = (1 - t) * 0.25;
      camera.position.y = startY + (Math.random() - 0.5) * mag;
      camera.position.x = (Math.random() - 0.5) * mag;
      requestAnimationFrame(shake);
    }
  };
  requestAnimationFrame(shake);

  // White flash, then load the Pluto surface
  const overlay = document.getElementById('transition-overlay');
  overlay.style.background = '#fff8e0';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.opacity = '1'; }, 1100);
  setTimeout(() => {
    overlay.style.background = '#000';   // reset for loadNextRoom's own fade
    transitioning = false;               // loadNextRoom expects to set it itself
    loadNextRoom();                      // → room 8 = pluto-surface
  }, 1900);
}

// ─── Room Transition ──────────────────────────────────────────────────────────
function checkDoorTransition() {
  if (transitioning || STATE.gameover) return;

  // Once ALL enemies are dead, mark the room/level cleared
  if (!roomCleared && ENEMIES.length === 0 && waveNumber >= WAVES_PER_ROOM) {
    roomCleared = true;
    if (STATE.level === 'space-cockpit') {
      // Begin Pluto approach — no portal, just close the distance and crash
      scene.userData.spacePhase = 'approach';
      showMessage('SPACE CLEAR! BRACE FOR PLUTO CRASH-LAND! 🪐', 4500);
    } else if (STATE.level === 'saturn-approach') {
      // All fighters destroyed — surge into Saturn for the crash finale
      scene.userData.spacePhase = 'approach';
      showMessage('FIGHTERS DOWN! INCOMING SATURN! 🪐💥', 4500);
    } else if (STATE.level === 'pluto-surface') {
      // A rocketship lands on the ice (visible from anywhere)
      buildPlutoRocketship();
      showMessage('A ROCKETSHIP DESCENDS! BOARD IT TO REACH NEPTUNE! 🚀', 4500);
    } else if (STATE.level === 'neptune-surface') {
      // Vacuums all destroyed — but a UFO descends to kidnap the dog!
      showMessage('VACUUMS DESTROYED! BUT WHAT IS THAT IN THE SKY..? 👽', 3500);
      setTimeout(() => { if (!transitioning && !STATE.gameover) triggerKidnap(); }, 2500);
    } else if (STATE.level === 'uranus-surface') {
      // Captors defeated — commandeer their rocket and escape toward Saturn
      buildPlutoRocketship();
      showMessage('CAPTORS DEFEATED! THEIR ROCKETSHIP IS YOURS! 🚀', 4500);
    } else if (STATE.level === 'saturn-surface') {
      // Water-gun aliens defeated — Jupiter portal opens
      buildJupiterPortal();
      showMessage('WATER GUNS BROKEN! A JUPITER PORTAL APPEARS! 🌀', 4500);
    } else if (STATE.level === 'jupiter-surface') {
      // Tennis balls down — a glowing dig spot opens up in the clouds
      buildJupiterDigSpot();
      showMessage('TENNIS BALLS POPPED! A DIG SITE APPEARS — DIG DOWN! ⛏️', 4500);
    } else if (isOceanLike(STATE.level)) {
      portalActive = true;
      const ring = scene.userData.portalRing;
      const disc = scene.userData.portalDisc;
      if (ring) {
        ring.material.emissive.setHex(0x66ffd0);
        ring.material.emissiveIntensity = 3.0;
      }
      if (disc) {
        disc.material.color.setHex(0x88ffe0);
        disc.material.opacity = 0.85;
      }
      const msg = STATE.level === 'ocean-surface'
        ? 'PORTAL ACTIVE! BOARD THE BOAT AND STEP INTO THE PORTAL! 🌀'
        : STATE.level === 'ocean-underwater'
          ? 'PORTAL ACTIVE! SWIM TO THE GLOWING RING! 🌀'
          : 'PORTAL ACTIVE! REACH THE BOW PORTAL — INTO SPACE! 🌀';
      showMessage(msg, 4500);
    } else {
      const blocker = scene.userData.doorBlocker;
      const doorLight = scene.userData.doorLight;
      if (blocker) blocker.visible = false;
      if (doorLight) doorLight.color.setHex(0x00ffaa);
      showMessage('ALL CLEAR! DOOR IS OPEN — GO FETCH THE NEXT ROOM! 🐾', 4000);
    }
  }

  if (STATE.level === 'pluto-surface' || STATE.level === 'uranus-surface') {
    // Walk into the rocketship to depart
    const rocket = scene.userData.rocket;
    if (rocket) {
      const dx = camera.position.x - rocket.position.x;
      const dz = camera.position.z - rocket.position.z;
      if (Math.sqrt(dx*dx + dz*dz) < 1.6) {
        if (!transitioning) launchPlutoRocket();
      }
    }
  } else if (STATE.level === 'saturn-surface') {
    // Walk into the Jupiter portal once it's active
    const portal = scene.userData.portal;
    if (portalActive && portal) {
      const dx = camera.position.x - portal.position.x;
      const dy = camera.position.y - portal.position.y;
      const dz = camera.position.z - portal.position.z;
      if (Math.sqrt(dx*dx + dy*dy + dz*dz) < 1.6) {
        if (!transitioning) triggerJupiterArrival();
      }
    }
  } else if (STATE.level === 'jupiter-surface') {
    // Walk into the dig site to descend → cat ship
    if (JUPITER_DIG.active && JUPITER_DIG.mesh && !transitioning) {
      const dx = camera.position.x - JUPITER_DIG.mesh.position.x;
      const dz = camera.position.z - JUPITER_DIG.mesh.position.z;
      if (Math.sqrt(dx*dx + dz*dz) < 1.6) triggerJupiterDig();
    }
  } else if (isSpaceLike(STATE.level)) {
    // No portal — handled in updateSpaceProgress (drives crash/landing sequence)
  } else if (isOceanLike(STATE.level)) {
    // Portal collision
    const portal = scene.userData.portal;
    if (portalActive && portal) {
      const dx = camera.position.x - portal.position.x;
      const dy = camera.position.y - portal.position.y;
      const dz = camera.position.z - portal.position.z;
      if (Math.sqrt(dx*dx + dy*dy + dz*dz) < 1.4) {
        // Pirate ship portal → space; ocean surface/underwater → next ocean level
        loadNextRoom();
      }
    }
  } else {
    // Walk through door (north wall)
    if (roomCleared && camera.position.z < -9.1 && Math.abs(camera.position.x) < 1.5) {
      loadNextRoom();
    }
  }
}

function victoryGame() {
  transitioning = true;
  STATE.gameover = true;  // freeze gameplay
  try { document.exitPointerLock(); } catch (e) { /* no-op on touch */ }
  hideAllOverlaysExceptGameOver();
  TOUCH.moveX = 0; TOUCH.moveZ = 0; TOUCH.lookX = 0; TOUCH.lookY = 0;
  // Re-theme victory screen depending on how we got here
  const t = document.getElementById('victory-title');
  const s1 = document.getElementById('victory-sub1');
  const s2 = document.getElementById('victory-sub2');
  if (STATE.level === 'cat-ship-hijack') {
    if (t) t.textContent = 'HIJACKED!';
    if (s1) s1.textContent = 'YOU ARE THE FIGHTER NOW — COSMIC GOOD BOY';
    if (s2) s2.textContent = `…the next chapter is coming • ${STATE.diamonds} 💎`;
  } else if (STATE.level === 'jupiter-surface') {
    if (t) t.textContent = 'JUPITER!';
    if (s1) s1.textContent = 'DUG INTO THE GAS GIANT';
    if (s2) s2.textContent = `…cat ships await below • ${STATE.diamonds} 💎`;
  } else if (STATE.level === 'saturn-surface') {
    if (t) t.textContent = 'JUPITER!';
    if (s1) s1.textContent = 'PORTAL CROSSED • THE BIGGEST PLANET AWAITS';
    if (s2) s2.textContent = `…the great red spot in the next update • ${STATE.diamonds} 💎`;
  } else if (STATE.level === 'saturn-approach') {
    if (t) t.textContent = 'SATURN!';
    if (s1) s1.textContent = 'YOU CRASHED THROUGH THE RINGS — HEROIC FINISH';
    if (s2) s2.textContent = `THE GOODEST DOG IN THE SOLAR SYSTEM • ${STATE.diamonds} 💎`;
  } else if (STATE.level === 'uranus-surface') {
    if (t) t.textContent = 'ESCAPED!';
    if (s1) s1.textContent = 'ALIEN CAPTORS DEFEATED • COSMIC GOOD BOY';
    if (s2) s2.textContent = `THE WHOLE SOLAR SYSTEM IS YOURS NOW • ${STATE.diamonds} 💎`;
  } else if (STATE.level === 'neptune-surface') {
    if (t) t.textContent = 'GOOD BOY!';
    if (s1) s1.textContent = 'VACUUMS DEFEATED • RUINS RECLAIMED';
    if (s2) s2.textContent = `THE GOODEST DOG IN THE SOLAR SYSTEM • ${STATE.diamonds} 💎`;
  } else if (STATE.level === 'neptune-approach') {
    if (t) t.textContent = 'NEPTUNE!';
    if (s1) s1.textContent = 'BOSS DEFEATED • SAFE LANDING';
    if (s2) s2.textContent = `+20 DIAMONDS AWARDED • TOTAL ${STATE.diamonds}`;
  } else if (isSpaceLike(STATE.level)) {
    if (t) t.textContent = 'PLUTO!';
    if (s1) s1.textContent = 'YOU CRASH-LANDED THE COCKPIT';
    if (s2) s2.textContent = '…the ice plains await in the next update';
  } else {
    if (t) t.textContent = 'VICTORY!';
    if (s1) s1.textContent = 'YOU MADE IT THROUGH THE PORTAL';
    if (s2) s2.textContent = '…another world awaits in the next update';
  }
  const overlay = document.getElementById('transition-overlay');
  overlay.style.background = '#ffffff';
  overlay.style.opacity = '1';
  setTimeout(() => {
    const vs = document.getElementById('victory-screen');
    vs.classList.add('shown');
    vs.style.display = 'flex';
    overlay.style.opacity = '0';
    overlay.style.background = '#000';
  }, 700);
}

function loadNextRoom() {
  transitioning = true;
  currentRoom++;
  STATE.level = levelForRoom(currentRoom) || 'dungeon';

  // Fade to black
  const overlay = document.getElementById('transition-overlay');
  overlay.style.opacity = '1';

  setTimeout(() => {
    // Clear old room: every direct child of scene except camera. Deep-dispose
    // each child's geometries/materials so GPU memory doesn't grow over the
    // session as the player hops levels.
    const toRemove = [];
    for (const child of scene.children) {
      if (child !== camera) toRemove.push(child);
    }
    for (const obj of toRemove) { disposeObjectTree(obj); scene.remove(obj); }

    // Clear pickup arrays + projectile/enemy arrays
    ENEMIES.length = 0;
    PROJECTILES.length = 0;
    ENEMY_PROJECTILES.length = 0;
    BONE_PICKUPS.length = 0;
    TREAT_PICKUPS.length = 0;
    DIAMOND_PICKUPS.length = 0;
    SPACE_PICKUPS.length = 0;
    DIRT_PICKUPS.length = 0;
    NAIL_PICKUPS.length = 0;
    PLUTO_CRACKS.length = 0;
    JUPITER_DIG.mesh = null; JUPITER_DIG.active = false;
    scene.userData = {};
    portalActive = false;

    // Ammo handoff between worlds
    if (isOceanLike(STATE.level) && STATE.diamonds === 0) STATE.diamonds = 12;
    if (STATE.level === 'dungeon' && STATE.bones === 0) STATE.bones = 30;
    if (isSpaceLike(STATE.level) && STATE.lasers === 0) STATE.lasers = 24;
    if (STATE.level === 'neptune-surface' && STATE.dirt === 0) STATE.dirt = 18;
    if (STATE.level === 'saturn-surface' && STATE.nails === 0) STATE.nails = 30;

    playerYaw = Math.PI;
    playerVelocityY = 0;

    buildLevel(STATE.level);

    waveTimer = 5;
    waveNumber = 0;
    roomCleared = false;

    document.getElementById('room-num').textContent = levelLabel(STATE.level, currentRoom);
    overlay.style.opacity = '0';
    transitioning = false;
    const intro = {
      'ocean-surface':    'THE OCEAN! REACH THE PIRATE BOAT — BEWARE OF SHARKS! 🦈',
      'ocean-underwater': 'DOWN INTO THE DEEP! SHARKS LURK BELOW! 🌊',
      'pirate-ship':      'AHOY! BOARD THE PIRATE SHIP! FIGHT THE CREW! ☠️',
      'space-cockpit':    'BLAST OFF! NEAR-LIGHT-SPEED TO PLUTO! ALIEN SHIPS INCOMING! 🚀',
      'pluto-surface':    'PLUTO! SPACESUIT ON. WATCH THE CRACKS — MARTIANS INCOMING! 👽',
      'neptune-surface':  'NEPTUNE RUINS! AN ANCIENT CITY… BUT EVIL VACUUMS APPROACH! 😱',
      'uranus-surface':   'URANUS! YOU WERE KIDNAPPED — FIGHT THE GRAY ALIENS! 👽⚡',
      'saturn-approach':  'INTO SATURN\'S RINGS! TIE FIGHTERS! F = MISSILE 🚀⚔️',
      'saturn-surface':   'SATURN STORM! WATER-GUN ALIENS! NAILGUN AT THE READY! 🔨💧',
      'jupiter-surface':  'JUPITER STORM! CHASE THE TENNIS BALLS — BITE TO DESTROY! 🎾🦷',
      'cat-ship-hijack':  'TRAPPED IN A CAT SHIP CAGE… 😾',
      'dungeon':          `ROOM ${currentRoom} — SPOOKIER IN HERE...`,
    };
    showMessage(intro[STATE.level] || '', 3500);
    updateHUD();
  }, 800);
}

// ─── Update Enemies ───────────────────────────────────────────────────────────
function updateEnemies(dt) {
  const t = clock.getElapsedTime();
  const inDungeon = STATE.level === 'dungeon';
  const onSurface = STATE.level === 'ocean-surface';
  const inSpace = isSpaceLike(STATE.level);
  for (const e of ENEMIES) {
    if (e.userData.isTennisBall) {
      updateTennisBall(e, dt, t);
      // Contact bump: if they ram into the player, push the player a bit
      const dx = e.position.x - camera.position.x;
      const dz = e.position.z - camera.position.z;
      const cdist = Math.sqrt(dx*dx + dz*dz);
      if (cdist < 1.4) {
        // Cosmetic damage — not a deadly attack, just a nudge
        e.userData.attackTimer = (e.userData.attackTimer || 0) - dt;
        if (e.userData.attackTimer <= 0) {
          e.userData.attackTimer = 1.4;
          damagePlayer(8);
        }
      }
      continue;
    }

    if (e.userData.isWaterAlien) {
      // ── Water-gun alien: chase player, spray water blobs ──
      const to = new THREE.Vector3().subVectors(camera.position, e.position);
      to.y = 0;
      const dist = to.length();
      to.normalize();
      e.rotation.y = Math.atan2(to.x, to.z);

      // Maintain ~5m distance for spraying
      if (dist > 8) e.position.addScaledVector(to, e.userData.speed * dt);
      else if (dist < 3.5) e.position.addScaledVector(to, -e.userData.speed * 0.6 * dt);
      // Side strafe
      const side = new THREE.Vector3(-to.z, 0, to.x);
      e.position.addScaledVector(side, Math.sin(t * 1.5 + e.userData.bobOffset) * dt * 0.9);
      // Slight bob
      e.position.y = Math.sin(t * 3 + e.userData.bobOffset) * 0.04;

      // Spray a water blob if gun is still intact
      e.userData.attackTimer -= dt;
      if (!e.userData.gunBroken && e.userData.attackTimer <= 0 && dist < 14) {
        e.userData.attackTimer = 1.0 + Math.random() * 0.6;
        // Fire from the gun's tip (world position of the barrel tip)
        const gunFront = new THREE.Vector3(0, 0.95, 1.6);
        gunFront.applyEuler(new THREE.Euler(0, e.rotation.y, 0));
        const from = e.position.clone().add(gunFront);
        const dir = new THREE.Vector3().subVectors(camera.position, from).normalize();
        spawnWaterBlob(from, dir);
      }
      continue;
    }

    if (e.userData.isFighter) {
      // ── Star-wars-style fighter behavior: arc past, fire lasers ──
      const to = new THREE.Vector3().subVectors(camera.position, e.position);
      const dist = to.length();
      to.normalize();

      e.userData.approachT += dt;
      // Hold ~18m for a few seconds, then peel off
      if (dist > 22) {
        e.position.addScaledVector(to, e.userData.speed * dt);
      } else if (dist < 14) {
        // Peel off — fly past the cockpit
        e.position.addScaledVector(to, -e.userData.speed * 0.5 * dt);
        // Sideways arc
        const side = new THREE.Vector3(-to.z, 0, to.x);
        e.position.addScaledVector(side, Math.sin(e.userData.approachT * 1.2 + e.userData.driftPhase) * dt * 3);
      }
      // Vertical wobble
      e.position.y += Math.sin(t * 2 + e.userData.bobOffset) * dt * 0.6;

      // Face the player (fighter's +Z is its nose, so yaw by atan2)
      e.rotation.y = Math.atan2(to.x, to.z);
      // X-wings roll for that hero shot
      if (!e.userData.isTie) {
        e.rotation.z = Math.sin(t * 1.8 + e.userData.driftPhase) * 0.4;
      } else {
        e.rotation.z = 0;
      }

      // Fire lasers at the player
      e.userData.attackTimer -= dt;
      if (e.userData.attackTimer <= 0 && dist < 32) {
        e.userData.attackTimer = 1.2 + Math.random() * 0.7;
        // Fire from slightly in front of the fighter
        const fwd = new THREE.Vector3().subVectors(camera.position, e.position).normalize();
        const from = e.position.clone().add(fwd.clone().multiplyScalar(1.0));
        spawnEnemyLaser(from, fwd, 10);
      }
      continue;
    }

    if (e.userData.isGrayAlien) {
      // ── Gray alien: stays back, fires psychic blasts ──
      const to = new THREE.Vector3().subVectors(camera.position, e.position);
      to.y = 0;
      const dist = to.length();
      to.normalize();
      e.rotation.y = Math.atan2(to.x, to.z);

      // Maintain ~8m distance
      if (dist > 11) e.position.addScaledVector(to, e.userData.speed * dt);
      else if (dist < 6) e.position.addScaledVector(to, -e.userData.speed * 0.7 * dt);
      // Slow side strafe
      const side = new THREE.Vector3(-to.z, 0, to.x);
      e.position.addScaledVector(side, Math.sin(t * 1.4 + e.userData.bobOffset) * dt * 0.8);
      // Body bob
      e.position.y = Math.sin(t * 2 + e.userData.bobOffset) * 0.04;
      // Halo pulse
      if (e.userData.halo) e.userData.halo.intensity = 0.5 + Math.sin(t * 5 + e.userData.bobOffset) * 0.35;

      // Fire psychic blast (red enemy laser)
      e.userData.attackTimer -= dt;
      if (e.userData.attackTimer <= 0 && dist < 18) {
        e.userData.attackTimer = 1.8 + Math.random() * 0.8;
        const from = e.position.clone().add(new THREE.Vector3(0, 1.5, 0));
        const dir = new THREE.Vector3().subVectors(camera.position, from).normalize();
        spawnEnemyLaser(from, dir, 11);
      }
      continue;
    }

    if (e.userData.isVacuum) {
      // ── Evil Vacuum behavior (rolls toward dog with growing dread) ──
      const to = new THREE.Vector3().subVectors(camera.position, e.position);
      to.y = 0;
      const dist = to.length();
      to.normalize();
      e.rotation.y = Math.atan2(to.x, to.z);
      if (dist > 1.4) {
        e.position.addScaledVector(to, e.userData.speed * dt);
      }
      // Sit on the ground (small vibration)
      e.position.y = Math.sin(t * 14 + e.userData.bobOffset) * 0.02;
      // Eye pulses brighter the closer it gets — fear builds
      if (e.userData.eyeLight) {
        const closeness = Math.max(0, 1 - dist / 14);
        e.userData.eyeLight.intensity = 1.0 + closeness * 2.5 + Math.sin(t * 5) * 0.4;
      }
      // Suction visual flickers
      if (e.userData.suction) {
        e.userData.suction.material.opacity = 0.12 + (0.06 + Math.sin(t * 8 + e.userData.bobOffset) * 0.04);
        e.userData.suction.scale.y = 1 + Math.sin(t * 6 + e.userData.bobOffset) * 0.15;
      }
      // Attack on contact (suction hit)
      e.userData.attackTimer -= dt;
      if (e.userData.attackTimer <= 0 && dist < 1.7) {
        e.userData.attackTimer = 1.3;
        damagePlayer(16);
      }
      continue;
    }

    if (e.userData.isMartian) {
      // ── Martian behavior (ground, three writhing heads + tentacles) ──
      const to = new THREE.Vector3().subVectors(camera.position, e.position);
      to.y = 0;
      const dist = to.length();
      to.normalize();

      // Face the player
      e.rotation.y = Math.atan2(to.x, to.z);

      // Lurching gait
      if (dist > 1.4) {
        e.position.addScaledVector(to, e.userData.speed * dt);
      }
      // Body bob
      e.position.y = Math.sin(t * 2.5 + e.userData.bobOffset) * 0.06;

      // Heads bob asynchronously
      if (e.userData.heads) {
        for (const h of e.userData.heads) {
          h.position.y = h.userData.baseY + Math.sin(t * 3.5 + h.userData.bobPhase) * 0.08;
          h.rotation.y = Math.sin(t * 1.5 + h.userData.bobPhase) * 0.3;
        }
      }
      // Tentacles writhe
      if (e.userData.tentacles) {
        for (const tent of e.userData.tentacles) {
          tent.rotation.x = Math.sin(t * 4 + tent.userData.phase) * 0.4;
          tent.rotation.z = Math.cos(t * 3.5 + tent.userData.phase) * 0.4;
        }
      }

      // Tentacle slap on contact
      e.userData.attackTimer -= dt;
      if (e.userData.attackTimer <= 0 && dist < 2.0) {
        e.userData.attackTimer = 1.4;
        damagePlayer(18);
      }

      // Keep martians out of cracks too — push them out of the rectangle
      const crack = isInCrack(e.position.x, e.position.z);
      if (crack) {
        const dx = e.position.x - crack.x;
        const dz = e.position.z - crack.z;
        const d = Math.sqrt(dx*dx + dz*dz) || 1;
        e.position.x += (dx / d) * 0.4;
        e.position.z += (dz / d) * 0.4;
      }
      continue;
    }

    if (e.userData.isBoss) {
      // ── Boss behavior: drifts at distance, fires from each turret, spins slowly ──
      const to = new THREE.Vector3().subVectors(camera.position, e.position);
      const dist = to.length();
      to.normalize();

      // Hold ~25-30m ahead; slow strafing drift
      const holdDist = 26;
      if (dist > holdDist + 3) {
        e.position.addScaledVector(to, 1.5 * dt);
      } else if (dist < holdDist - 3) {
        e.position.addScaledVector(to, -1.5 * dt);
      }
      e.position.x += Math.sin(t * 0.6 + e.userData.driftPhase) * 1.2 * dt;
      e.position.y += Math.sin(t * 0.4 + e.userData.bobOffset) * 0.3 * dt;

      // Slow rotation so all 4 turrets get a turn pointing at the player
      e.rotation.y += dt * 0.35;
      // Slight tilt
      e.rotation.z = Math.sin(t * 0.8 + e.userData.driftPhase) * 0.06;

      // Blink rim pods
      if (e.userData.lights) {
        for (const l of e.userData.lights) {
          l.visible = Math.sin(t * 4 + l.userData.blinkPhase) > 0;
        }
      }

      // Pulse weak point
      if (e.userData.weakCore) {
        const k = 0.85 + Math.sin(t * 6) * 0.15;
        e.userData.weakCore.scale.setScalar(k);
      }
      if (e.userData.weakLight) {
        e.userData.weakLight.intensity = 2.8 + Math.sin(t * 5) * 1.2;
      }

      // Fire cannons sequentially
      e.userData.attackTimer -= dt;
      if (e.userData.attackTimer <= 0) {
        e.userData.attackTimer = 1.1 + Math.random() * 0.5;
        // Pick the turret currently most aimed at player (boss is spinning, so always one)
        let best = null, bestDot = -2;
        const toPlayerWorld = new THREE.Vector3().subVectors(camera.position, e.position).normalize();
        for (const turret of e.userData.cannons) {
          const tipWorld = new THREE.Vector3();
          turret.userData.tip.getWorldPosition(tipWorld);
          const fwd = new THREE.Vector3().subVectors(tipWorld, e.position).normalize();
          const dot = fwd.dot(toPlayerWorld);
          if (dot > bestDot) { bestDot = dot; best = turret; }
        }
        if (best) {
          const tipWorld = new THREE.Vector3();
          best.userData.tip.getWorldPosition(tipWorld);
          const dir = new THREE.Vector3().subVectors(camera.position, tipWorld).normalize();
          spawnEnemyLaser(tipWorld, dir, 13);
          best.userData.tip.material.color.setHex(0xffffff);
          setTimeout(() => best.userData.tip.material.color.setHex(0xff4060), 100);
        }
      }
      continue;
    }

    if (e.userData.isAlienShip) {
      // ── Alien Ship behavior (full 3D, no gravity, fires lasers) ──
      const to = new THREE.Vector3().subVectors(camera.position, e.position);
      const dist = to.length();
      to.normalize();

      // Hold a distance — close in, then strafe
      const holdDist = 12;
      if (dist > holdDist) {
        e.position.addScaledVector(to, e.userData.speed * dt);
      } else {
        // Sideways drift to feel evasive
        const side = new THREE.Vector3(-to.z, 0, to.x);
        e.position.addScaledVector(side, Math.sin(t * 1.5 + e.userData.driftPhase) * e.userData.speed * 0.5 * dt);
      }
      // Gentle bob
      e.position.y += Math.sin(t * 2 + e.userData.bobOffset) * 0.01;
      // Tilt slightly
      e.rotation.z = Math.sin(t * 1.2 + e.userData.driftPhase) * 0.25;
      e.rotation.y += dt * 0.6;

      // Blink underside lights
      if (e.userData.lights) {
        for (const l of e.userData.lights) {
          l.visible = (Math.sin(t * 6 + l.userData.blinkPhase) > 0);
        }
      }

      // Fire laser at player
      e.userData.attackTimer -= dt;
      if (e.userData.attackTimer <= 0 && dist < 35) {
        e.userData.attackTimer = 1.6 + Math.random() * 1.4;
        const dir = new THREE.Vector3().subVectors(camera.position, e.position).normalize();
        // Spawn from underside of saucer
        const from = e.position.clone().add(new THREE.Vector3(0, -0.3, 0));
        spawnEnemyLaser(from, dir, 12);
      }

      // Contact ram damage
      if (dist < 1.5) {
        e.userData.attackTimer = Math.max(e.userData.attackTimer, 1.0);
        damagePlayer(20);
        // Knock ship back so it doesn't keep ramming every frame
        e.position.addScaledVector(to, -2);
      }
      continue;
    }

    // Look at player
    const toPlayer = new THREE.Vector3().subVectors(camera.position, e.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    toPlayer.normalize();

    if (e.userData.isShark) {
      // Sharks face direction of motion (point with snout, -z)
      e.rotation.y = Math.atan2(-toPlayer.x, -toPlayer.z);
    } else {
      e.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
    }

    // Move toward player
    if (dist > 1.2) {
      e.position.addScaledVector(toPlayer, e.userData.speed * dt);
    }

    if (e.userData.isShark) {
      // Skim along surface, slight side-to-side wobble
      e.position.y = Math.sin(t * 2 + e.userData.bobOffset) * 0.04;
      e.rotation.z = Math.sin(t * 3 + e.userData.bobOffset) * 0.12;
    } else if (e.userData.isPirate) {
      // Pirate on deck (raised platform y=2.7 floor)
      e.position.y = 1.4 + Math.sin(t * 4 + e.userData.bobOffset) * 0.06;
    } else {
      // Cat bob
      e.position.y = Math.sin(t * 3 + e.userData.bobOffset) * 0.05;
    }

    // Attack
    e.userData.attackTimer -= dt;
    if (e.userData.attackTimer <= 0 && dist < 1.5) {
      e.userData.attackTimer = 1.5;
      damagePlayer(e.userData.isShark ? 18 : e.userData.isPirate ? 20 : 15);
    }

    if (e.userData.isPirate) {
      // Keep pirates on the deck (inside railings)
      e.position.x = Math.max(-SHIP_BOUND_X + 0.4, Math.min(SHIP_BOUND_X - 0.4, e.position.x));
      e.position.z = Math.max(-SHIP_BOUND_Z + 1.0, Math.min(SHIP_BOUND_Z - 1.0, e.position.z));
    }

    if (inDungeon) {
      // Pillar collision (dungeon only)
      const PILLAR_RADIUS = 0.5;
      for (const [px, pz] of [[-6,-6],[6,-6],[-6,6],[6,6]]) {
        const dx = e.position.x - px;
        const dz = e.position.z - pz;
        const d = Math.sqrt(dx*dx + dz*dz);
        if (d < PILLAR_RADIUS) {
          e.position.x = px + (dx/d) * PILLAR_RADIUS;
          e.position.z = pz + (dz/d) * PILLAR_RADIUS;
        }
      }
    } else if (onSurface) {
      // Boat hull collision — push shark off boat footprint
      const HULL_HALF_X = 2.8;
      const HULL_HALF_Z = 5.0;
      if (Math.abs(e.position.x) < HULL_HALF_X && Math.abs(e.position.z) < HULL_HALF_Z) {
        const overX = HULL_HALF_X - Math.abs(e.position.x);
        const overZ = HULL_HALF_Z - Math.abs(e.position.z);
        if (overX < overZ) {
          e.position.x = Math.sign(e.position.x || 1) * HULL_HALF_X;
        } else {
          e.position.z = Math.sign(e.position.z || 1) * HULL_HALF_Z;
        }
      }
    }
  }
}

function damagePlayer(amount) {
  STATE.health = Math.max(0, STATE.health - amount);
  updateHUD();
  // Screen flash red
  const hud = document.getElementById('hud');
  hud.style.background = 'rgba(255,0,0,0.25)';
  setTimeout(() => { hud.style.background = 'transparent'; }, 150);

  if (STATE.health <= 0) gameOver();
}

// ─── Particles update ─────────────────────────────────────────────────────────
function updateParticles(dt) {
  const particles = scene.userData.particles;
  if (!particles) return;
  // Hard cap: drop oldest scene-particles so explosions can't unbound the heap.
  // We *don't* dispose materials here — some particle spawners share one
  // material across their batch (e.g. spawnDeathParticles), and disposing it
  // would break every sibling particle still rendering.
  while (particles.length > MAX_PARTICLES) {
    const old = particles.shift();
    scene.remove(old);
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.userData.life -= dt;
    p.userData.vel.y -= 9.8 * dt;
    p.position.addScaledVector(p.userData.vel, dt);
    if (p.material && p.material.opacity !== undefined) p.material.opacity = p.userData.life / 0.8;
    if (p.userData.life <= 0) {
      scene.remove(p);
      particles.splice(i, 1);
    }
  }
}

// ─── Atmospheric FX ───────────────────────────────────────────────────────────
function updateAtmosphere(dt) {
  const t = clock.getElapsedTime();

  // Flicker main lantern (dungeon only)
  const lantern = scene.userData.lantern;
  if (lantern && STATE.level === 'dungeon') {
    const base = diff().lantern;
    lantern.intensity = base + Math.sin(t * 7.3) * 0.8 + Math.sin(t * 17.1) * 0.4;
  }

  // Flicker torch lights
  const torches = scene.userData.torchLights;
  if (torches) {
    for (let i = 0; i < torches.length; i++) {
      torches[i].intensity = 4.0 + Math.sin(t * (5 + i) + i) * 1.0;
    }
  }

  // Flicker cage lights
  const cages = scene.userData.cageLights;
  if (cages) {
    for (let i = 0; i < cages.length; i++) {
      cages[i].intensity = 0.5 + Math.sin(t * (9 + i * 2)) * 0.2;
    }
  }

  // Flicker runes
  const runes = scene.userData.runes;
  if (runes) {
    for (const rune of runes) {
      rune.material.opacity = 0.5 + Math.sin(t * 4 + rune.userData.flicker) * 0.3;
    }
  }

  // Ocean-surface: water waves + boat sway
  if (STATE.level === 'ocean-surface') {
    const water = scene.userData.water;
    const baseZ = scene.userData.waterBaseZ;
    if (water && baseZ) {
      const pos = water.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const wave = Math.sin(x * 0.4 + t * 1.3) * 0.18 + Math.cos(y * 0.35 + t * 1.1) * 0.16;
        pos.setZ(i, baseZ[i] + wave);
      }
      pos.needsUpdate = true;
      // Keep the normal recompute — without it the displaced surface lights
      // wrong (looks "glitchy"). The water plane is now 30×30 = 900 verts
      // (was 60×60) so this is ~4× cheaper than before.
      water.geometry.computeVertexNormals();
    }
    const boat = scene.userData.boat;
    if (boat) {
      boat.rotation.z = Math.sin(t * 0.6) * 0.02;
      boat.position.y = Math.sin(t * 0.8) * 0.06;
    }
  }

  // Underwater: floating bubbles + sway seaweed
  if (STATE.level === 'ocean-underwater') {
    const bubbles = scene.userData.bubbles;
    if (bubbles) {
      for (const b of bubbles) {
        b.position.y += dt * b.userData.rise;
        b.position.x += Math.sin(t * 2 + b.userData.phase) * dt * 0.2;
        if (b.position.y > 10) {
          b.position.y = -1;
          b.position.x = (Math.random() - 0.5) * 40;
          b.position.z = (Math.random() - 0.5) * 40;
        }
      }
    }
    const seaweeds = scene.userData.seaweeds;
    if (seaweeds) {
      for (const s of seaweeds) {
        s.rotation.z = Math.sin(t * 1.2 + s.userData.phase) * 0.18;
      }
    }
  }

  // Pirate ship: sail flap + ship sway
  if (STATE.level === 'pirate-ship') {
    const ship = scene.userData.ship;
    if (ship) {
      ship.rotation.z = Math.sin(t * 0.5) * 0.015;
      ship.position.y = Math.sin(t * 0.7) * 0.05;
    }
  }

  // Uranus surface: outpost blinker
  if (STATE.level === 'uranus-surface') {
    const outpost = scene.userData.outpost;
    if (outpost && outpost.userData.blinker) {
      outpost.userData.blinker.visible = Math.sin(t * 3) > 0;
    }
  }

  // Saturn surface: occasional sky flash + portal pulse (when active)
  if (STATE.level === 'saturn-surface') {
    const flash = scene.userData.saturnFlash;
    if (flash) {
      const strike = Math.sin(t * 0.7) * Math.sin(t * 2.1) > 0.92;
      flash.intensity = strike ? 4.5 + Math.random() * 3 : 0.25 + Math.sin(t * 2) * 0.1;
    }
    const portal = scene.userData.portal;
    if (portal) {
      portal.rotation.z += dt * 0.6;
      if (portalActive && scene.userData.portalLight) {
        scene.userData.portalLight.intensity = 1.3 + Math.sin(t * 4) * 0.7;
      }
    }
  }

  // Neptune surface: occasional lightning flash
  if (STATE.level === 'neptune-surface') {
    const flash = scene.userData.neptuneFlash;
    if (flash) {
      // Strike about once every ~6s
      const strike = Math.sin(t * 0.6) * Math.sin(t * 1.7) > 0.93;
      flash.intensity = strike ? 5.0 + Math.random() * 3 : 0.3 + Math.sin(t * 2) * 0.15;
    }
  }

  // Rocketship (Pluto + Uranus): flame flicker + door ring pulse
  if (STATE.level === 'pluto-surface' || STATE.level === 'uranus-surface') {
    const rocket = scene.userData.rocket;
    if (rocket) {
      if (rocket.userData.flame) {
        rocket.userData.flame.scale.y = 1 + Math.sin(t * 20) * 0.18 + Math.sin(t * 7) * 0.1;
      }
      if (rocket.userData.door) {
        rocket.userData.door.material.opacity = 0.55 + Math.sin(t * 4) * 0.3;
      }
      if (rocket.userData.glow) {
        rocket.userData.glow.intensity = 2.0 + Math.sin(t * 6) * 0.6;
      }
    }
  }

  // Space: scroll stars + streaks toward camera at near-light speed
  if (isSpaceLike(STATE.level)) {
    const phase = scene.userData.spacePhase;
    const speed = phase === 'approach' ? 220 : phase === 'crash' ? 60 : 130;
    const stars = scene.userData.stars;
    if (stars) {
      const pos = stars.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let z = pos.getZ(i) + speed * dt;
        if (z > 5) {
          z = -220 + (z - 5);  // recycle far ahead
          pos.setX(i, (Math.random() - 0.5) * 80);
          pos.setY(i, (Math.random() - 0.5) * 80);
        }
        pos.setZ(i, z);
      }
      pos.needsUpdate = true;
    }
    const streaks = scene.userData.streaks;
    if (streaks) {
      const pos = streaks.geometry.attributes.position;
      for (let i = 0; i < pos.count / 2; i++) {
        let z1 = pos.getZ(i*2) + speed * dt;
        let z2 = pos.getZ(i*2 + 1) + speed * dt;
        if (z1 > 5) {
          const x = (Math.random() - 0.5) * 45;
          const y = (Math.random() - 0.5) * 30;
          z1 = -180; z2 = z1 + 2.5;
          pos.setX(i*2,     x); pos.setY(i*2,     y);
          pos.setX(i*2 + 1, x); pos.setY(i*2 + 1, y);
        }
        pos.setZ(i*2,     z1);
        pos.setZ(i*2 + 1, z2);
      }
      pos.needsUpdate = true;
    }
    // Saturn ring debris streaming past
    const debris = scene.userData.ringDebris;
    if (debris) {
      const debSpeed = phase === 'approach' ? 220 : phase === 'crash' ? 60 : 80;
      for (const d of debris) {
        d.position.z += debSpeed * dt;
        d.rotation.x += d.userData.spin.x * dt;
        d.rotation.y += d.userData.spin.y * dt;
        d.rotation.z += d.userData.spin.z * dt;
        if (d.position.z > 5) {
          d.position.set(
            (Math.random() - 0.5) * 32,
            (Math.random() - 0.5) * 18,
            -110 + (d.position.z - 5),
          );
        }
      }
    }

    // Dashboard button blinking
    const btns = scene.userData.dashButtons;
    if (btns) {
      for (const b of btns) {
        const lit = Math.sin(t * 3 + b.userData.blinkPhase) > 0.4;
        b.material.color.setHex(lit ? b.userData.baseColor : 0x202020);
      }
    }
    // Radar sweep
    const sweep = scene.userData.radarSweep;
    if (sweep) sweep.rotation.z = t * 2.5;
  }

  // Portal pulse (all ocean-like levels)
  if (isOceanLike(STATE.level)) {
    const portal = scene.userData.portal;
    if (portal) {
      portal.rotation.z += dt * 0.6;
      if (portalActive && scene.userData.portalLight) {
        scene.userData.portalLight.intensity = 1.0 + Math.sin(t * 4) * 0.6;
      }
    }
  }
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function updateHUD() {
  document.getElementById('health-fill').style.width = STATE.health + '%';
  document.getElementById('bone-count').textContent = STATE.bones;
  const diaEl = document.getElementById('diamond-count');
  if (diaEl) diaEl.textContent = STATE.diamonds;
  const lasEl = document.getElementById('laser-count');
  if (lasEl) lasEl.textContent = STATE.lasers;
  const dirtEl = document.getElementById('dirt-count');
  if (dirtEl) dirtEl.textContent = STATE.dirt;
  const misEl = document.getElementById('missile-count');
  if (misEl) misEl.textContent = STATE.missiles;
  const nailEl = document.getElementById('nail-count');
  if (nailEl) nailEl.textContent = STATE.nails;
  const inOcean = isOceanLike(STATE.level);
  const inSpace = isSpaceLike(STATE.level);
  const isDirtLevel  = STATE.level === 'neptune-surface';
  const isLaserLevel = inSpace && !isDirtLevel;
  const isMissileLevel = STATE.level === 'saturn-approach';
  const isNailLevel    = STATE.level === 'saturn-surface';
  document.getElementById('bones-display').style.display    = (!inOcean && !inSpace) ? 'block' : 'none';
  const dd = document.getElementById('diamonds-display'); if (dd) dd.style.display = inOcean ? 'block' : 'none';
  const ld = document.getElementById('lasers-display');   if (ld) ld.style.display = (isLaserLevel && !isNailLevel) ? 'block' : 'none';
  const dr = document.getElementById('dirt-display');     if (dr) dr.style.display = isDirtLevel ? 'block' : 'none';
  const mi = document.getElementById('missiles-display'); if (mi) mi.style.display = isMissileLevel ? 'block' : 'none';
  // Touch missile button: only when on a missile level AND there's at least one missile loaded
  const touchMis = document.getElementById('touch-missile');
  if (touchMis) touchMis.style.display = (TOUCH.active && isMissileLevel && STATE.missiles > 0) ? 'block' : 'none';
  const na = document.getElementById('nails-display');    if (na) na.style.display = isNailLevel ? 'block' : 'none';
  const prefix = document.getElementById('room-prefix');
  if (prefix) prefix.style.display = STATE.level === 'dungeon' ? 'inline' : 'none';
  drawDogFace(STATE.health);
}

function drawDogFace(health) {
  const canvas = document.getElementById('dog-face');
  if (!canvas) return;
  const c = canvas.getContext('2d');
  const W = 80, H = 80;
  c.clearRect(0, 0, W, H);

  const hurt    = health < 30;
  const worried = health < 60;

  const FUR      = '#c07840';   // main coat
  const FUR_DARK = '#8a4e20';   // ears / shadow
  const FUR_LITE = '#e8b070';   // forehead / bridge
  const MUZZLE   = '#e8d090';   // pale muzzle
  const JOWL     = '#d4a060';   // jowl cheeks

  // ── Floppy ears — wide, hang down past chin ──
  c.fillStyle = FUR_DARK;
  // Left ear: wide rounded flap hanging down left side
  c.beginPath();
  c.moveTo(14, 18);
  c.bezierCurveTo(2, 16,  2, 38,  8, 58);
  c.bezierCurveTo(12, 66, 20, 64, 22, 54);
  c.bezierCurveTo(18, 40, 14, 28, 16, 18);
  c.closePath(); c.fill();

  // Right ear
  c.beginPath();
  c.moveTo(66, 18);
  c.bezierCurveTo(78, 16, 78, 38, 72, 58);
  c.bezierCurveTo(68, 66, 60, 64, 58, 54);
  c.bezierCurveTo(62, 40, 66, 28, 64, 18);
  c.closePath(); c.fill();

  // Inner ear highlight
  c.fillStyle = '#b06838';
  c.beginPath(); c.ellipse(12, 40, 4, 14, -0.15, 0, Math.PI*2); c.fill();
  c.beginPath(); c.ellipse(68, 40, 4, 14,  0.15, 0, Math.PI*2); c.fill();

  // ── Head — rounder top, wider middle ──
  c.fillStyle = FUR;
  c.beginPath();
  c.ellipse(40, 34, 24, 22, 0, 0, Math.PI * 2);
  c.fill();

  // ── Forehead lighter stripe ──
  c.fillStyle = FUR_LITE;
  c.beginPath(); c.ellipse(40, 24, 11, 9, 0, 0, Math.PI * 2); c.fill();

  // ── Jowl cheeks — puff out from under eyes ──
  c.fillStyle = JOWL;
  c.beginPath(); c.ellipse(26, 50, 10, 9, -0.2, 0, Math.PI*2); c.fill();
  c.beginPath(); c.ellipse(54, 50, 10, 9,  0.2, 0, Math.PI*2); c.fill();

  // ── Muzzle — long, prominent snout ──
  c.fillStyle = MUZZLE;
  c.beginPath();
  c.ellipse(40, 55, 14, 13, 0, 0, Math.PI * 2);
  c.fill();

  // ── Nose — wide, flat dog nose ──
  c.fillStyle = '#1a0808';
  c.beginPath();
  c.ellipse(40, 48, 8, 5.5, 0, 0, Math.PI * 2);
  c.fill();
  // Nostrils
  c.fillStyle = '#0a0404';
  c.beginPath(); c.ellipse(36.5, 49, 2.2, 1.5, 0.3, 0, Math.PI*2); c.fill();
  c.beginPath(); c.ellipse(43.5, 49, 2.2, 1.5,-0.3, 0, Math.PI*2); c.fill();
  // Nose shine
  c.fillStyle = 'rgba(255,255,255,0.45)';
  c.beginPath(); c.ellipse(37.5, 46.5, 2.5, 1.5, -0.3, 0, Math.PI*2); c.fill();

  // ── Eyes — round, low on head (dog proportion) ──
  const eyeY = hurt ? 34 : 32;
  for (const [ex, tilt] of [[27, 0.18], [53, -0.18]]) {
    // Brown iris
    c.fillStyle = '#5c2e08';
    c.beginPath(); c.ellipse(ex, eyeY, 7, 6.5, tilt, 0, Math.PI*2); c.fill();
    // Dark pupil
    c.fillStyle = '#0d0808';
    c.beginPath(); c.ellipse(ex, eyeY + (hurt ? 1 : 0), 4.5, 4.5, 0, 0, Math.PI*2); c.fill();
    // Catchlight
    c.fillStyle = '#fff';
    c.beginPath(); c.ellipse(ex+2.5, eyeY-2, 2, 1.8, -0.4, 0, Math.PI*2); c.fill();
    // Lower lid (jowl line)
    c.strokeStyle = FUR_DARK;
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(ex, eyeY + 1, 6.5, 0.15, Math.PI - 0.15);
    c.stroke();
  }

  // ── Eyebrows / brow ridge ──
  c.strokeStyle = FUR_DARK;
  c.lineWidth = 2.2;
  c.lineCap = 'round';
  if (hurt) {
    c.beginPath(); c.moveTo(19, 24); c.quadraticCurveTo(27, 28, 33, 27); c.stroke();
    c.beginPath(); c.moveTo(61, 24); c.quadraticCurveTo(53, 28, 47, 27); c.stroke();
  } else if (worried) {
    c.beginPath(); c.moveTo(19, 25); c.quadraticCurveTo(27, 27, 33, 26); c.stroke();
    c.beginPath(); c.moveTo(61, 25); c.quadraticCurveTo(53, 27, 47, 26); c.stroke();
  } else {
    c.beginPath(); c.moveTo(19, 27); c.quadraticCurveTo(26, 23, 33, 25); c.stroke();
    c.beginPath(); c.moveTo(61, 27); c.quadraticCurveTo(54, 23, 47, 25); c.stroke();
  }

  // ── Mouth line on muzzle ──
  c.strokeStyle = '#9a6030';
  c.lineWidth = 1.5;
  // Philtrum (center line down from nose)
  c.beginPath(); c.moveTo(40, 54); c.lineTo(40, 59); c.stroke();
  if (hurt) {
    // Sad mouth corners down
    c.beginPath(); c.moveTo(31, 59); c.quadraticCurveTo(40, 57, 49, 59); c.stroke();
    c.beginPath(); c.moveTo(31, 59); c.quadraticCurveTo(28, 63, 31, 65); c.stroke();
    c.beginPath(); c.moveTo(49, 59); c.quadraticCurveTo(52, 63, 49, 65); c.stroke();
  } else {
    // Happy — mouth corners up
    c.beginPath(); c.moveTo(31, 60); c.quadraticCurveTo(40, 58, 49, 60); c.stroke();
    c.beginPath(); c.moveTo(31, 60); c.quadraticCurveTo(27, 64, 30, 66); c.stroke();
    c.beginPath(); c.moveTo(49, 60); c.quadraticCurveTo(53, 64, 50, 66); c.stroke();
    // Tongue
    c.fillStyle = '#ff5577';
    c.beginPath(); c.ellipse(40, 67, 6, 7, 0, 0, Math.PI*2); c.fill();
    c.fillStyle = '#dd3355';
    c.fillRect(37.5, 67, 5, 1.2);
  }

  // ── Damage blood tint ──
  if (hurt) {
    c.fillStyle = 'rgba(160,0,0,0.22)';
    c.beginPath(); c.ellipse(40, 40, 32, 36, 0, 0, Math.PI*2); c.fill();
  }
}

let messageTimeout = null;
function showMessage(text, duration = 2000) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(messageTimeout);
  messageTimeout = setTimeout(() => { el.style.opacity = '0'; }, duration);
}

function gameOver() {
  STATE.gameover = true;
  try { document.exitPointerLock(); } catch (e) { /* no-op on touch */ }
  // Hide everything that could obscure the game-over overlay on mobile
  hideAllOverlaysExceptGameOver();
  TOUCH.moveX = 0; TOUCH.moveZ = 0; TOUCH.lookX = 0; TOUCH.lookY = 0;
  const showLevelBtn = currentRoom > 1 || STATE.level !== 'dungeon';
  const btn = document.getElementById('restart-level-btn');
  if (btn) {
    btn.style.display = showLevelBtn ? 'inline-block' : 'none';
    btn.textContent = STATE.level === 'dungeon'
      ? `RETRY ROOM ${currentRoom}`
      : `RETRY ${levelLabel(STATE.level, currentRoom)}`;
  }
  const rs = document.getElementById('restart-screen');
  rs.classList.add('shown');
  rs.style.display = 'flex';   // belt and suspenders alongside the class
}

function hideAllOverlaysExceptGameOver() {
  // Anything that could sit at or above z-index 100 and visually block the
  // game-over screen on iOS Safari (where stacking can be quirky).
  const ids = ['touch-ui', 'visor', 'play-hint', 'dev-menu', 'start-screen', 'message'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

// Shared teardown + rebuild used by full restart, level restart, and victory restart.
function rebuildLevel(fromBeginning) {
  if (fromBeginning) {
    currentRoom = 1;
    STATE.level = 'dungeon';
  }

  STATE.health = 100;
  STATE.gameover = false;
  STATE.started = true;
  waveTimer = 5;
  waveNumber = 0;
  transitioning = false;
  roomCleared = false;
  portalActive = false;

  const inOcean = isOceanLike(STATE.level);
  const inSpace = isSpaceLike(STATE.level);
  if (STATE.level === 'neptune-surface') { STATE.dirt = 18; STATE.lasers = 0; STATE.bones = 30; STATE.diamonds = 0; STATE.nails = 0; }
  else if (STATE.level === 'saturn-surface') { STATE.nails = 30; STATE.lasers = 0; STATE.bones = 30; STATE.diamonds = 0; STATE.dirt = 0; }
  else if (inSpace)                       { STATE.lasers = 24; STATE.bones = 30; STATE.diamonds = 0; STATE.dirt = 0; STATE.nails = 0; }
  else if (inOcean)                       { STATE.diamonds = 12; STATE.bones = 30; STATE.lasers = 0; STATE.dirt = 0; STATE.nails = 0; }
  else                                    { STATE.bones = 30;  STATE.diamonds = 0; STATE.lasers = 0; STATE.dirt = 0; STATE.nails = 0; }

  // Tear down ALL scene children except camera (camera holds dog view model).
  // Deep-dispose each subtree's geometries + non-persistent materials so the
  // GPU isn't carrying state from every previous level.
  const toRemove = [];
  for (const child of scene.children) {
    if (child !== camera) toRemove.push(child);
  }
  for (const obj of toRemove) { disposeObjectTree(obj); scene.remove(obj); }

  ENEMIES.length = 0;
  PROJECTILES.length = 0;
  ENEMY_PROJECTILES.length = 0;
  BONE_PICKUPS.length = 0;
  TREAT_PICKUPS.length = 0;
  DIAMOND_PICKUPS.length = 0;
  SPACE_PICKUPS.length = 0;
  DIRT_PICKUPS.length = 0;
  NAIL_PICKUPS.length = 0;
  PLUTO_CRACKS.length = 0;
  JUPITER_DIG.mesh = null; JUPITER_DIG.active = false;

  scene.userData = {};

  playerYaw = inOcean ? Math.PI : 0;
  playerPitch = 0;
  playerVelocityY = 0;

  buildLevel(STATE.level);

  document.getElementById('room-num').textContent = levelLabel(STATE.level, currentRoom);
  const rs = document.getElementById('restart-screen');
  rs.classList.remove('shown');
  rs.style.display = 'none';
  const vs = document.getElementById('victory-screen');
  vs.classList.remove('shown');
  vs.style.display = 'none';
  // Re-show overlays that gameOver hid (touch UI, visor)
  if (TOUCH.active) {
    const tui = document.getElementById('touch-ui');
    if (tui) tui.style.display = 'block';
  }
  // Visor visibility is set fresh by buildLevel via setSpacesuitVisor for each level
  // rebuildLevel runs from a button click (Try Again / Retry Level / dev menu warp),
  // so we have a user gesture and can safely auto-lock the pointer.
  lockPointer();
  updateHUD();
}

// Build the requested level (lights, geometry, pickups, player position, held item)
function buildLevel(level) {
  setSpacesuitVisor(level === 'pluto-surface');
  // Boss HUD is only shown during the Neptune fight — the spawner re-shows it
  const bossWrap = document.getElementById('boss-bar-wrap');
  if (bossWrap) bossWrap.style.display = 'none';
  if (level === 'dungeon') {
    scene.fog = new THREE.FogExp2(0x0a0005, 0.07);
    renderer.setClearColor(0x050005);
    camera.position.set(0, PLAYER_HEIGHT, currentRoom === 1 ? 0 : 8);
    swapHeldToBone();
    buildRoom(currentRoom);
    const bonesCount  = currentRoom === 1 ? diff().boneBase  : diff().bonePerRoom  + currentRoom;
    const treatsCount = currentRoom === 1 ? diff().treatBase : diff().treatPerRoom + currentRoom;
    spawnBonePickups(bonesCount);
    spawnTreatPickups(treatsCount);
    addLighting();
  } else if (level === 'ocean-surface') {
    scene.fog = new THREE.FogExp2(0x88c0e6, 0.025);
    renderer.setClearColor(0x88c0e6);
    camera.position.set(0, PLAYER_HEIGHT, 14);
    swapHeldToDiamond();
    buildOceanSurface();
    spawnDiamondPickups(8);
    spawnTreatPickups(diff().treatBase);
  } else if (level === 'ocean-underwater') {
    scene.fog = new THREE.FogExp2(0x0a3a5a, 0.05);
    renderer.setClearColor(0x0a3a5a);
    camera.position.set(0, PLAYER_HEIGHT, 18);
    swapHeldToDiamond();
    buildUnderwater();
    spawnDiamondPickups(10);
    spawnTreatPickups(diff().treatBase + 1);
  } else if (level === 'pirate-ship') {
    scene.fog = new THREE.FogExp2(0x224a6a, 0.018);
    renderer.setClearColor(0x224a6a);
    camera.position.set(0, PLAYER_HEIGHT + 1.4, 14);
    swapHeldToDiamond();
    buildPirateShip();
    spawnDiamondPickups(6);   // diamond placement adapted inside the ship builder
    spawnTreatPickups(diff().treatBase + 1);
  } else if (level === 'space-cockpit') {
    scene.fog = null;                 // deep space — no fog
    renderer.setClearColor(0x000005);
    camera.position.set(0, PLAYER_HEIGHT + 0.4, 0);
    playerYaw = 0; playerPitch = 0;
    swapHeldToLaser();
    setSpacesuitVisor(false);
    if (STATE.lasers === 0) STATE.lasers = 24;
    buildSpaceCockpit();
    spawnSpaceHealthPacks(5);
    spawnSpaceLaserPacks(4);
  } else if (level === 'pluto-surface') {
    scene.fog = new THREE.FogExp2(0x081020, 0.02);
    renderer.setClearColor(0x020414);
    camera.position.set(0, PLAYER_HEIGHT, 16);
    playerYaw = Math.PI;
    swapHeldToBlaster();
    setSpacesuitVisor(true);
    if (STATE.lasers === 0) STATE.lasers = 32;
    buildPlutoSurface();
    spawnTreatPickups(diff().treatBase + 2);
  } else if (level === 'neptune-approach') {
    scene.fog = null;
    renderer.setClearColor(0x000010);
    camera.position.set(0, PLAYER_HEIGHT + 0.4, 0);
    playerYaw = 0; playerPitch = 0;
    swapHeldToLaser();
    setSpacesuitVisor(false);
    if (STATE.lasers < 30) STATE.lasers = 50;   // top up for boss fight
    buildNeptuneApproach();
    spawnSpaceHealthPacks(4);
    spawnSpaceLaserPacks(4);
  } else if (level === 'neptune-surface') {
    scene.fog = new THREE.FogExp2(0x1a2a4a, 0.022);
    renderer.setClearColor(0x1a2a4a);
    camera.position.set(0, PLAYER_HEIGHT, 18);
    playerYaw = Math.PI;
    swapHeldToDirt();
    setSpacesuitVisor(true);
    if (STATE.dirt < 10) STATE.dirt = 18;
    buildNeptuneSurface();
    spawnDirtPickups(8);
    spawnTreatPickups(diff().treatBase + 2);
  } else if (level === 'uranus-surface') {
    scene.fog = new THREE.FogExp2(0x4080a8, 0.022);
    renderer.setClearColor(0x4080a8);
    camera.position.set(0, PLAYER_HEIGHT, 16);
    playerYaw = Math.PI;
    swapHeldToBlaster();
    setSpacesuitVisor(true);
    if (STATE.lasers < 25) STATE.lasers = 45;
    buildUranusSurface();
    spawnTreatPickups(diff().treatBase + 2);
  } else if (level === 'saturn-approach') {
    scene.fog = null;
    renderer.setClearColor(0x000005);
    camera.position.set(0, PLAYER_HEIGHT + 0.4, 0);
    playerYaw = 0; playerPitch = 0;
    swapHeldToLaser();
    setSpacesuitVisor(false);
    if (STATE.lasers < 30) STATE.lasers = 60;
    if (STATE.missiles < 4) STATE.missiles = 6;
    buildSaturnApproach();
    spawnSpaceHealthPacks(4);
    spawnSpaceLaserPacks(3);
    spawnSpaceMissilePacks(3);
  } else if (level === 'saturn-surface') {
    scene.fog = new THREE.FogExp2(0x801008, 0.038);
    renderer.setClearColor(0x401008);
    camera.position.set(0, PLAYER_HEIGHT, 18);
    playerYaw = Math.PI;
    swapHeldToNailgun();
    setSpacesuitVisor(true);
    if (STATE.nails < 15) STATE.nails = 30;
    buildSaturnSurface();
    spawnNailPickups(7);
    spawnGroundMedkits(diff().treatBase + 2);
  } else if (level === 'jupiter-surface') {
    scene.fog = new THREE.FogExp2(0xc06030, 0.028);
    renderer.setClearColor(0x804020);
    camera.position.set(0, PLAYER_HEIGHT, 20);
    playerYaw = Math.PI;
    swapHeldToFangs();
    setSpacesuitVisor(true);
    buildJupiterSurface();
    spawnGroundMedkits(diff().treatBase + 2);
  } else if (level === 'cat-ship-hijack') {
    scene.fog = null;
    renderer.setClearColor(0x101820);
    camera.position.set(0, PLAYER_HEIGHT + 0.4, 0);
    playerYaw = 0; playerPitch = 0;
    swapHeldToBone();    // dog is back to mouth-only — about to chew bars
    setSpacesuitVisor(false);
    buildCatShipHijack();
    startCatShipHijackSequence();
  }
}

function restartGame() {
  rebuildLevel(true);
  showMessage('GOOD BOY — TRY AGAIN!', 2500);
}
window.restartGame = restartGame;

function restartLevel() {
  rebuildLevel(false);
  const label = STATE.level === 'dungeon' ? `ROOM ${currentRoom}` : levelLabel(STATE.level, currentRoom);
  showMessage(`RETRY ${label}!`, 2500);
}
window.restartLevel = restartLevel;

// ─── Dev secret level-warp menu ──────────────────────────────────────────────
const DEV_ROOMS = [
  { room: 1, label: 'Room 1 — Dungeon' },
  { room: 2, label: 'Room 2 — Dungeon' },
  { room: 3, label: 'Room 3 — Dungeon' },
  { room: 4, label: 'Room 4 — Ocean Surface' },
  { room: 5, label: 'Room 5 — Underwater' },
  { room: 6, label: 'Room 6 — Pirate Ship' },
  { room: 7, label: 'Room 7 — Space Cockpit' },
  { room: 8, label: 'Room 8 — Pluto Surface' },
  { room: 9, label: 'Room 9 — Neptune Boss' },
  { room: 10, label: 'Room 10 — Neptune Surface' },
  { room: 11, label: 'Room 11 — Uranus (Kidnapped!)' },
  { room: 12, label: 'Room 12 — Saturn Rings (Dogfight)' },
  { room: 13, label: 'Room 13 — Saturn Surface (Storm)' },
  { room: 14, label: 'Room 14 — Jupiter (Tennis Balls)' },
  { room: 15, label: 'Room 15 — Cat Ship Hijack' },
];

function toggleDevMenu() {
  const el = document.getElementById('dev-menu');
  if (!el) return;
  if (el.style.display === 'none' || el.style.display === '') {
    renderDevMenu();
    el.style.display = 'block';
    document.exitPointerLock();
  } else {
    el.style.display = 'none';
    // Triggered by ` key — not a click, so the browser may refuse the lock.
    // The hint will appear automatically via pointerlockchange if so.
    if (STATE.started && !STATE.gameover) {
      lockPointer();
    }
  }
}

function renderDevMenu() {
  const list = document.getElementById('dev-menu-list');
  if (!list) return;
  list.innerHTML = '';
  for (const r of DEV_ROOMS) {
    const btn = document.createElement('button');
    btn.textContent = r.label;
    btn.style.cssText = 'display:block; width:100%; margin:4px 0; padding:10px 14px; background:transparent; border:1px solid #00ff88; color:#00ff88; font-family:\'Courier New\',monospace; font-size:13px; letter-spacing:2px; text-align:left; cursor:pointer; text-shadow:0 0 6px #00ff88;';
    btn.onmouseover = () => { btn.style.background = '#00ff88'; btn.style.color = '#000'; };
    btn.onmouseout  = () => { btn.style.background = 'transparent'; btn.style.color = '#00ff88'; };
    btn.onclick = () => warpToRoom(r.room);
    list.appendChild(btn);
  }
}

function warpToRoom(roomNum) {
  document.getElementById('dev-menu').style.display = 'none';
  currentRoom = roomNum;
  STATE.level = levelForRoom(roomNum) || 'dungeon';
  // rebuildLevel sets ammo + health based on STATE.level
  rebuildLevel(false);
  showMessage(`⚡ WARPED TO ${levelLabel(STATE.level, currentRoom)} ⚡`, 2500);
}
window.warpToRoom = warpToRoom;

// ─── Wave Spawner ─────────────────────────────────────────────────────────────
let waveTimer = 5;
let waveNumber = 0;
const WAVES_PER_ROOM = 3; // clear 3 waves to unlock the door

function updateSpawner(dt) {
  if (STATE.gameover || roomCleared) return;
  // Cat ship is a scripted cinematic — no waves
  if (STATE.level === 'cat-ship-hijack') return;
  // Neptune is a one-and-done boss fight: spawn the boss exactly once
  if (STATE.level === 'neptune-approach') {
    if (waveNumber === 0) {
      waveNumber = WAVES_PER_ROOM;   // satisfy clear condition once boss dies
      spawnAlienBoss();
      const wrap = document.getElementById('boss-bar-wrap');
      if (wrap) wrap.style.display = 'block';
      const lbl = document.getElementById('boss-label');
      if (lbl) lbl.textContent = 'ALIEN MOTHERSHIP';
      updateBossHud(scene.userData.boss);
      showMessage('ALIEN MOTHERSHIP! AIM FOR THE RED CORE! ⚠️', 4500);
    }
    return;
  }
  if (waveNumber >= WAVES_PER_ROOM) return;
  waveTimer -= dt;
  if (waveTimer <= 0) {
    waveNumber++;
    const count = Math.min(1 + Math.floor(waveNumber / 2), 4);
    let enemyLabel = 'ALIEN CAT';
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      if (STATE.level === 'ocean-surface') {
        const r = 12 + Math.random() * 3;
        spawnShark(Math.cos(angle) * r, Math.sin(angle) * r);
        enemyLabel = 'SHARK';
      } else if (STATE.level === 'ocean-underwater') {
        const r = 14 + Math.random() * 4;
        spawnShark(Math.cos(angle) * r, Math.sin(angle) * r);
        enemyLabel = 'DEEP SHARK';
      } else if (STATE.level === 'pirate-ship') {
        // Pirates spawn at the bow or stern (far ends of the deck), not all around
        const fromBow = Math.random() < 0.5;
        const x = (Math.random() - 0.5) * 6;
        const z = fromBow ? -14 : 14;
        spawnPirate(x, z);
        enemyLabel = 'PIRATE';
      } else if (STATE.level === 'pluto-surface') {
        // Martians lurch in from the edges of the ice plain
        const r = 14 + Math.random() * 5;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        spawnMartian(x, z);
        enemyLabel = 'MARTIAN';
      } else if (STATE.level === 'neptune-surface') {
        // Vacuums roll in from beyond the rubble — dog's worst nightmare
        const r = 16 + Math.random() * 5;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        spawnVacuum(x, z);
        enemyLabel = 'VACUUM';
      } else if (STATE.level === 'uranus-surface') {
        // Gray aliens shimmer in around the outpost
        const r = 12 + Math.random() * 5;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        spawnGrayAlien(x, z);
        enemyLabel = 'GRAY ALIEN';
      } else if (STATE.level === 'saturn-approach') {
        // Star-wars fighters peel out of the rings — mix of TIE + X-Wing
        const kind = Math.random() < 0.55 ? 'tie' : 'xwing';
        const xx = (Math.random() - 0.5) * 28;
        const yy = (Math.random() - 0.5) * 10 + 1;
        const zz = -28 - Math.random() * 18;
        spawnFighter(kind, xx, yy, zz);
        enemyLabel = kind === 'tie' ? 'TIE FIGHTER' : 'X-WING';
      } else if (STATE.level === 'saturn-surface') {
        // Water-gun aliens appear from gaps in the gas pillars
        const r = 13 + Math.random() * 5;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        spawnWaterAlien(x, z);
        enemyLabel = 'WATER ALIEN';
      } else if (STATE.level === 'jupiter-surface') {
        // Giant tennis balls bounce in from the edges
        const r = 15 + Math.random() * 5;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        spawnTennisBall(x, z);
        enemyLabel = 'TENNIS BALL';
      } else if (isSpaceLike(STATE.level)) {
        // Alien ships warp in ahead of the cockpit, spread out
        const x = (Math.random() - 0.5) * 22;
        const y = (Math.random() - 0.5) * 8 + 1;
        const z = -25 - Math.random() * 12;
        spawnAlienShip(x, y, z);
        enemyLabel = 'ALIEN SHIP';
      } else {
        const r = 7 + Math.random() * 2;
        spawnCat(Math.cos(angle) * r, Math.sin(angle) * r);
      }
    }
    const remaining = WAVES_PER_ROOM - waveNumber;
    const suffix = remaining > 0 ? ` (${remaining} wave${remaining > 1 ? 's' : ''} left)` : ' — LAST WAVE!';
    showMessage(`WAVE ${waveNumber} — ${count} ${enemyLabel}${count > 1 ? 'S' : ''}!${suffix}`, 2500);
    waveTimer = 14;
  }
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
function loop() {
  requestAnimationFrame(loop);
  if (!STATE.started) {
    renderer.render(scene, camera);
    return;
  }

  const dt = Math.min(clock.getDelta(), 0.05);

  // After death, freeze the simulation entirely. Without this guard, enemies
  // kept moving and the touch joystick kept driving the camera around behind
  // the game-over screen — making the death feel "ignored" on mobile.
  if (STATE.gameover) {
    renderer.render(scene, camera);
    return;
  }

  if (transitioning) {
    // During Pluto crash we still want stars & Pluto to keep moving
    if (isSpaceLike(STATE.level)) {
      updateAtmosphere(dt);
      updateSpaceProgress(dt);
    }
    renderer.render(scene, camera);
    return;
  }
  updatePlayer(dt);
  updateProjectiles(dt);
  updateEnemyProjectiles(dt);
  updateEnemies(dt);
  updateBonePickups(dt);
  updateDiamondPickups(dt);
  updateTreatPickups(dt);
  updateSpacePickups(dt);
  updateDirtPickups(dt);
  updateNailPickups(dt);
  updateSaturnWind(dt);
  updateJupiterStorm(dt);
  updateCatShipHijack(dt);
  updateParticles(dt);
  updateExplosions(dt);
  updateAtmosphere(dt);
  updateSpaceProgress(dt);
  updateSpawner(dt);
  checkDoorTransition();

  renderer.render(scene, camera);
}

// Re-apply difficulty to scene that was already built with defaults
function applyDifficultyToScene() {
  const D = diff();
  if (scene.userData.ambient) scene.userData.ambient.intensity = D.ambient;
  if (scene.userData.lantern) scene.userData.lantern.intensity = D.lantern;
  const sconces = scene.userData.sconces || [];
  if (sconces[0]) sconces[0].intensity = D.sconceWarm;
  if (sconces[1]) sconces[1].intensity = D.sconceWarm;
  if (sconces[2]) sconces[2].intensity = D.sconceCool;
  if (sconces[3]) sconces[3].intensity = D.sconceCool;

  // Clear and respawn pickups so counts match new difficulty
  for (const b of BONE_PICKUPS) scene.remove(b);
  BONE_PICKUPS.length = 0;
  for (const t of TREAT_PICKUPS) scene.remove(t);
  TREAT_PICKUPS.length = 0;
  spawnBonePickups(D.boneBase);
  spawnTreatPickups(D.treatBase);
}

// ─── Public Start ─────────────────────────────────────────────────────────────
window.startGame = function (difficulty) {
  if (difficulty === 'easy' || difficulty === 'normal') {
    STATE.difficulty = difficulty;
  }
  applyDifficultyToScene();
  document.getElementById('start-screen').style.display = 'none';
  STATE.started = true;
  clock.start();
  // Auto-lock the cursor — we're inside the FETCH click handler, which is a valid user gesture.
  // pointerlockchange will show the hint if the browser refuses or the user presses Esc.
  lockPointer();
  const tag = STATE.difficulty === 'easy' ? 'EASY MODE — ' : '';
  showMessage(`${tag}DEFEND YOURSELF, GOOD BOY!`, 3000);
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────
init();
loop();
