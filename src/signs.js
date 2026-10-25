// Corner count-down boards: a post pair with a board showing the distance to
// the corner and an arrow for its direction. Faces are textured from a canvas atlas.

import { createMesh } from './gl.js';
import { SIGN_DISTANCES } from './track.js';

const BOARD_W = 1.9, BOARD_H = 2.5; // m
const BOARD_BOTTOM = 1.0;           // m above the ground
const TILE_W = 256, TILE_H = 337;   // px, same aspect as the board

// Atlas: one column per distance, rows for left / right turns.
function drawAtlas() {
  const cv = document.createElement('canvas');
  cv.width = TILE_W * SIGN_DISTANCES.length;
  cv.height = TILE_H * 2;
  const g = cv.getContext('2d');
  SIGN_DISTANCES.forEach((dist, col) => {
    [false, true].forEach((right, row) => {
      const x0 = col * TILE_W, y0 = row * TILE_H;
      g.fillStyle = '#c8202a';
      g.fillRect(x0, y0, TILE_W, TILE_H);
      g.fillStyle = '#ffffff';
      g.fillRect(x0 + 14, y0 + 14, TILE_W - 28, TILE_H - 28);
      g.fillStyle = '#111418';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `bold ${dist >= 100 ? 112 : 136}px "Chakra Petch", "Arial Black", Arial, sans-serif`;
      g.fillText(String(dist), x0 + TILE_W / 2, y0 + 118);
      // Chevron pointing the way the road turns.
      const cx = x0 + TILE_W / 2, cy = y0 + 248, s = right ? 1 : -1;
      g.beginPath();
      g.moveTo(cx - 34 * s, cy - 50);
      g.lineTo(cx + 26 * s, cy);
      g.lineTo(cx - 34 * s, cy + 50);
      g.lineWidth = 30;
      g.lineJoin = 'miter';
      g.strokeStyle = '#111418';
      g.stroke();
    });
  });
  return cv;
}

function createTexture(gl, canvas) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Sharper at grazing angles, so the numbers read from further away.
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return tex;
}

// Frame of a board: right (as the approaching driver sees it), up, and the
// direction it faces.
function boardFrame(s) {
  const [fx, fz] = s.facing;
  return { right: [fz, 0, -fx], up: [0, 1, 0], face: [fx, 0, fz] };
}

export class Signs {
  constructor(gl, program, signs) {
    this.signs = signs;
    this.texture = createTexture(gl, drawAtlas());
    // All board faces in one mesh.
    const positions = [], normals = [], uvs = [];
    const cols = SIGN_DISTANCES.length;
    for (const s of signs) {
      const { right, up, face } = boardFrame(s);
      const c = [s.x + face[0] * 0.07, s.y + BOARD_BOTTOM + BOARD_H / 2, s.z + face[2] * 0.07];
      const col = SIGN_DISTANCES.indexOf(s.dist), row = s.right ? 1 : 0;
      // The atlas is flipped on upload, so row 0 (top of the canvas) is v 0.5..1.
      const u0 = col / cols, u1 = (col + 1) / cols, v0 = (1 - row) * 0.5;
      const corner = (a, b) => {
        positions.push(...[0, 1, 2].map((k) => c[k] + right[k] * a * BOARD_W / 2 + up[k] * b * BOARD_H / 2));
        normals.push(...face);
        uvs.push(a < 0 ? u0 : u1, b < 0 ? v0 : v0 + 0.5);
      };
      // Counter-clockwise seen from the front.
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) corner(a, b);
    }
    this.faces = createMesh(gl, program, { positions, normals, uvs });
  }

  // Model matrices of the untextured parts (posts and board backing) as
  // [center, right, up, back, sx, sy, sz] for basis().
  parts() {
    const out = [];
    for (const s of this.signs) {
      const { right, up, face } = boardFrame(s);
      const back = face.map((v) => -v);
      const at = (dx, dy) => [s.x + right[0] * dx, s.y + dy, s.z + right[2] * dx];
      const postH = BOARD_BOTTOM + BOARD_H;
      out.push({ part: 'post', m: [at(-0.55, postH / 2 - 0.3), right, up, back, 0.12, postH + 0.6, 0.12] });
      out.push({ part: 'post', m: [at(0.55, postH / 2 - 0.3), right, up, back, 0.12, postH + 0.6, 0.12] });
      out.push({ part: 'board', m: [[s.x, s.y + BOARD_BOTTOM + BOARD_H / 2, s.z], right, up, back, BOARD_W + 0.04, BOARD_H + 0.04, 0.1] });
    }
    return out;
  }
}
