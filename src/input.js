// Keyboard state: arrows or WASD.
const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const any = (...codes) => codes.some((c) => keys.has(c));

export function readControls() {
  return {
    throttle: any('ArrowUp', 'KeyW') ? 1 : 0,
    brake: any('ArrowDown', 'KeyS') ? 1 : 0,
    steer: (any('ArrowLeft', 'KeyA') ? 1 : 0) - (any('ArrowRight', 'KeyD') ? 1 : 0),
    handbrake: any('Space') ? 1 : 0,
    reset: any('KeyR'),
  };
}
