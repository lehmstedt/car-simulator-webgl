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
