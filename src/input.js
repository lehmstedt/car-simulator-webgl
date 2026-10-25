// Keyboard (WASD / arrows), on-screen touch pads (elements with .pad[data-ctl])
// and an on-screen steering slider (#steer) you drag sideways.

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

let resetQueued = false, driveQueued = false, ghostQueued = false, viewQueued = false, layoutQueued = false;
document.getElementById('reset')?.addEventListener('click', () => { resetQueued = true; });
document.getElementById('drive')?.addEventListener('click', () => { driveQueued = true; });
document.getElementById('ghost')?.addEventListener('click', () => { ghostQueued = true; });
document.getElementById('view')?.addEventListener('click', () => { viewQueued = true; });
document.getElementById('layout')?.addEventListener('click', () => { layoutQueued = true; });
// Settings panel: the gear button toggles it; tapping elsewhere closes it.
const settingsBtn = document.getElementById('settings-btn');
const settingsEl = document.getElementById('settings');
const setSettings = (open) => {
  settingsEl.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
};
settingsBtn?.addEventListener('click', () => setSettings(settingsEl.hidden));
addEventListener('pointerdown', (e) => {
  if (settingsEl && !settingsEl.hidden && !e.target.closest('.top-right')) setSettings(false);
});
// Drop focus after a click so Space (handbrake) doesn't re-press the button.
document.querySelectorAll('.top-right button').forEach((b) => b.addEventListener('click', () => b.blur()));
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyT') driveQueued = true;
  if (e.code === 'KeyG') ghostQueued = true;
  if (e.code === 'KeyC') viewQueued = true;
  if (e.code === 'KeyM') layoutQueued = true;
});

// Steering wheel position: -1 (full right) .. 1 (full left). Keys turn it
// gradually and it springs back to center when released, like a real wheel.
const WHEEL_TURNS = 135;   // degrees the cockpit wheel turns at full lock
const TURN_RATE = 1.8;     // per second while a key is held (~0.55 s to full lock)
const COUNTER_RATE = 4;    // per second when steering against the current lock
const CENTER_RATE = 2.5;   // per second self-centering when let go
let wheel = 0;

// Touch slider: drag sideways to steer. Movement is relative to where the
// finger lands, so touching it never jerks the car; full lock is half the
// track's width. Let go and it springs back to center.
const sliderEl = document.getElementById('steer');
const knobEl = sliderEl?.querySelector('.knob');
let grab = null; // { id, x, start } while a finger holds the slider
if (sliderEl) {
  sliderEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (grab) return;
    try { sliderEl.setPointerCapture(e.pointerId); } catch {}
    grab = { id: e.pointerId, x: e.clientX, start: wheel };
    sliderEl.classList.add('on');
  });
  sliderEl.addEventListener('pointermove', (e) => {
    if (!grab || e.pointerId !== grab.id) return;
    const half = (knobEl?.parentElement.clientWidth ?? sliderEl.clientWidth) / 2;
    // Slide right = steer right = negative.
    wheel = Math.max(-1, Math.min(1, grab.start - (e.clientX - grab.x) / half));
  });
  const release = (e) => {
    if (!grab || e.pointerId !== grab.id) return;
    grab = null;
    sliderEl.classList.remove('on');
  };
  sliderEl.addEventListener('pointerup', release);
  sliderEl.addEventListener('pointercancel', release);
  sliderEl.addEventListener('lostpointercapture', release);
  sliderEl.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('blur', () => { grab = null; sliderEl.classList.remove('on'); });
}

const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

function updateWheel(dt) {
  if (!grab) {
    const dir = (any('ArrowLeft', 'KeyA') || pressed('left') ? 1 : 0) -
                (any('ArrowRight', 'KeyD') || pressed('right') ? 1 : 0);
    if (dir === 0) wheel = approach(wheel, 0, CENTER_RATE * dt);
    else wheel = approach(wheel, dir, (wheel * dir < 0 ? COUNTER_RATE : TURN_RATE) * dt);
  }
  if (knobEl) knobEl.style.left = `${50 - wheel * 50}%`;
  sliderEl?.setAttribute('aria-valuenow', (-wheel).toFixed(2));
}

export function resetWheel() { wheel = 0; }

// Wheel rotation in radians, for drawing the cockpit's steering wheel.
export const wheelAngle = () => wheel * WHEEL_TURNS * Math.PI / 180;

export function readControls(dt) {
  const reset = any('KeyR') || resetQueued;
  const switchDrive = driveQueued, toggleGhost = ghostQueued, toggleView = viewQueued, switchLayout = layoutQueued;
  resetQueued = driveQueued = ghostQueued = viewQueued = layoutQueued = false;
  updateWheel(dt);
  return {
    throttle: any('ArrowUp', 'KeyW') || pressed('gas') ? 1 : 0,
    brake: any('ArrowDown', 'KeyS') || pressed('brake') ? 1 : 0,
    steer: wheel,
    handbrake: any('Space') ? 1 : 0,
    reset,
    switchDrive,
    toggleGhost,
    toggleView,
    switchLayout,
  };
}
