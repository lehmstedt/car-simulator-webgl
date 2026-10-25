// Keyboard (WASD / arrows) and on-screen touch pads (elements with .pad[data-ctl]).

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

export function readControls() {
  const reset = any('KeyR') || resetQueued;
  const switchDrive = driveQueued;
  resetQueued = driveQueued = false;
  return {
    throttle: any('ArrowUp', 'KeyW') || pressed('gas') ? 1 : 0,
    brake: any('ArrowDown', 'KeyS') || pressed('brake') ? 1 : 0,
    steer: (any('ArrowLeft', 'KeyA') || pressed('left') ? 1 : 0) -
           (any('ArrowRight', 'KeyD') || pressed('right') ? 1 : 0),
    handbrake: any('Space') ? 1 : 0,
    reset,
    switchDrive,
  };
}
