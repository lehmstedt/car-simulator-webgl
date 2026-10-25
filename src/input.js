// Keyboard (WASD / arrows), on-screen touch pads (elements with .pad[data-ctl])
// and an on-screen steering wheel (#wheel) you drag to turn.

const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
const any = (...codes) => codes.some((c) => keys.has(c));

// Each pad tracks the pointers currently pressing it, so multi-touch works.
const pads = new Map();
for (const el of document.querySelectorAll('.pad[data-ctl]')) {
  const ids = new Set();
  pads.set(el.dataset.ctl, { el, ids });
  const down = (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    ids.add(e.pointerId);
    el.classList.add('on');
  };
  const up = (e) => {
    ids.delete(e.pointerId);
    if (!ids.size) el.classList.remove('on');
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
addEventListener('blur', () => {
  keys.clear();
  for (const { el, ids } of pads.values()) { ids.clear(); el.classList.remove('on'); }
});
const pressed = (k) => (pads.get(k)?.ids.size ?? 0) > 0;

let resetQueued = false, driveQueued = false;
document.getElementById('reset')?.addEventListener('click', () => { resetQueued = true; });
document.getElementById('drive')?.addEventListener('click', () => { driveQueued = true; });
addEventListener('keydown', (e) => { if (e.code === 'KeyT' && !e.repeat) driveQueued = true; });

// Steering wheel position: -1 (full right) .. 1 (full left). Keys turn it
// gradually and it springs back to center when released, like a real wheel.
const WHEEL_TURNS = 135;   // degrees of on-screen wheel rotation at full lock
const TURN_RATE = 1.8;     // per second while a key is held (~0.55 s to full lock)
const COUNTER_RATE = 4;    // per second when steering against the current lock
const CENTER_RATE = 2.5;   // per second self-centering when let go
let wheel = 0;

// Touch wheel: dragging around its center rotates it 1:1 with the finger.
const wheelEl = document.getElementById('wheel');
let grab = null; // { id, lastAngle } while a finger holds the wheel
if (wheelEl) {
  const angleOf = (e) => {
    const r = wheelEl.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  wheelEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (grab) return;
    try { wheelEl.setPointerCapture(e.pointerId); } catch {}
    grab = { id: e.pointerId, lastAngle: angleOf(e) };
    wheelEl.classList.add('on');
  });
  wheelEl.addEventListener('pointermove', (e) => {
    if (!grab || e.pointerId !== grab.id) return;
    const a = angleOf(e);
    let d = a - grab.lastAngle;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    grab.lastAngle = a;
    // Screen angles grow clockwise; clockwise = steer right = negative.
    wheel = Math.max(-1, Math.min(1, wheel - d / WHEEL_TURNS));
  });
  const release = (e) => {
    if (!grab || e.pointerId !== grab.id) return;
    grab = null;
    wheelEl.classList.remove('on');
  };
  wheelEl.addEventListener('pointerup', release);
  wheelEl.addEventListener('pointercancel', release);
  wheelEl.addEventListener('lostpointercapture', release);
  wheelEl.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('blur', () => { grab = null; wheelEl.classList.remove('on'); });
}

const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

function updateWheel(dt) {
  if (!grab) {
    const dir = (any('ArrowLeft', 'KeyA') || pressed('left') ? 1 : 0) -
                (any('ArrowRight', 'KeyD') || pressed('right') ? 1 : 0);
    if (dir === 0) wheel = approach(wheel, 0, CENTER_RATE * dt);
    else wheel = approach(wheel, dir, (wheel * dir < 0 ? COUNTER_RATE : TURN_RATE) * dt);
  }
  if (wheelEl) wheelEl.style.transform = `rotate(${-wheel * WHEEL_TURNS}deg)`;
}

export function resetWheel() { wheel = 0; }

export function readControls(dt) {
  const reset = any('KeyR') || resetQueued;
  const switchDrive = driveQueued;
  resetQueued = driveQueued = false;
  updateWheel(dt);
  return {
    throttle: any('ArrowUp', 'KeyW') || pressed('gas') ? 1 : 0,
    brake: any('ArrowDown', 'KeyS') || pressed('brake') ? 1 : 0,
    steer: wheel,
    handbrake: any('Space') ? 1 : 0,
    reset,
    switchDrive,
  };
}
