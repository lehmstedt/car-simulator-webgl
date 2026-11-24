// Small WebGL helpers: shader program + mesh upload.

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function createProgram(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p));
  }
  return p;
}

// mesh = { positions: number[], normals: number[], uvs?: number[], indices?: number[], mode? }
export function createMesh(gl, program, { positions, normals, uvs, indices, mode = gl.TRIANGLES }) {
  const vao = gl.createVertexArray(), buffers = [];
  gl.bindVertexArray(vao);
  const attach = (name, data, size = 3) => {
    const loc = gl.getAttribLocation(program, name);
    if (loc < 0) return; // attribute unused by this program
    const buf = gl.createBuffer();
    buffers.push(buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  attach('aPosition', positions);
  attach('aNormal', normals);
  if (uvs) attach('aUV', uvs, 2);
  if (indices) {
    const buf = gl.createBuffer();
    buffers.push(buf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
  }
  gl.bindVertexArray(null);
  return { vao, buffers, count: indices ? indices.length : positions.length / 3, mode, indexed: !!indices };
}

// Frees a mesh's GPU memory (when the scenery is rebuilt for another layout).
export function deleteMesh(gl, mesh) {
  gl.deleteVertexArray(mesh.vao);
  for (const b of mesh.buffers) gl.deleteBuffer(b);
}

// Whether this browser can draw with reversed-Z depth (see ReversedDepth).
// Asked of a throwaway context, since the canvas's own must be made knowing it.
export function canReverseDepth() {
  const probe = document.createElement('canvas').getContext('webgl2');
  const ok = !!probe?.getExtension('EXT_clip_control');
  probe?.getExtension('WEBGL_lose_context')?.loseContext();
  return ok;
}

// Reversed-Z depth: the scene is drawn into a multisampled target with a
// float depth buffer holding near / distance (1 at the near plane, 0 far
// away), then resolved onto the canvas. Floats are finest near 0, which
// cancels the squeeze of the perspective divide, so depth stays precise to a
// few mm out to the horizon. A plain 24-bit buffer with a 5 cm near plane
// can't tell apart surfaces a few cm apart past ~50 m: the ground, sidewalks,
// asphalt and paint flickered through each other.
// Depth tests GREATER, clears to 0, and polygon offsets pull toward the eye
// with positive values. Returns null if the target can't be made.
export function createReversedDepth(gl) {
  const ext = gl.getExtension('EXT_clip_control');
  if (!ext) return null;
  const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
  const fb = gl.createFramebuffer(), color = gl.createRenderbuffer(), depth = gl.createRenderbuffer();
  let w = 0, h = 0;
  const size = (width, height) => {
    w = width; h = height;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT32F, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  };
  size(1, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(color); gl.deleteRenderbuffer(depth);
    return null;
  }
  ext.clipControlEXT(ext.LOWER_LEFT_EXT, ext.ZERO_TO_ONE_EXT);
  gl.depthFunc(gl.GREATER);
  gl.clearDepth(0);
  return {
    // Sizes the target to the canvas and draws into it from now on.
    begin(width, height) {
      if (width !== w || height !== h) size(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    },
    // Resolves the frame onto the canvas.
    end() {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
  };
}
