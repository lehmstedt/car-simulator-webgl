// Skid marks: flat dark quads laid down behind sliding wheels, kept in a ring
// buffer so the oldest marks are recycled.

const WIDTH = 0.28;   // m
const MIN_STEP = 0.4; // m between segments

export class Skids {
  constructor(gl, program, capacity = 3000) {
    this.gl = gl;
    this.capacity = capacity;
    this.next = 0;
    this.used = 0;
    this.last = new Map(); // wheel id -> last [x, z] while sliding

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * 18 * 4, gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    const nbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nbuf);
    const normals = new Float32Array(capacity * 18);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    const nloc = gl.getAttribLocation(program, 'aNormal');
    gl.enableVertexAttribArray(nloc);
    gl.vertexAttribPointer(nloc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  // Call every frame for each wheel; y is the road surface height there.
  track(id, x, y, z, sliding) {
    if (!sliding) { this.last.delete(id); return; }
    const prev = this.last.get(id);
    if (!prev) { this.last.set(id, [x, z, y]); return; }
    const dx = x - prev[0], dz = z - prev[1], len = Math.hypot(dx, dz);
    if (len < MIN_STEP) return;
    if (len < 5) this.segment(prev[0], prev[2], prev[1], x, y, z, dx / len, dz / len);
    this.last.set(id, [x, z, y]);
  }

  segment(x0, y0, z0, x1, y1, z1, dx, dz) {
    const nx = -dz * WIDTH / 2, nz = dx * WIDTH / 2;
    const a = [x0 + nx, y0, z0 + nz], b = [x0 - nx, y0, z0 - nz];
    const c = [x1 - nx, y1, z1 - nz], d = [x1 + nx, y1, z1 + nz];
    const data = new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, this.next * 18 * 4, data);
    this.next = (this.next + 1) % this.capacity;
    this.used = Math.min(this.capacity, this.used + 1);
  }

  clear() {
    this.used = this.next = 0;
    this.last.clear();
  }

  get mesh() {
    return { vao: this.vao, count: this.used * 6, mode: this.gl.TRIANGLES };
  }
}
