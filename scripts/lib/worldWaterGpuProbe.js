// GPU parity of the exact packed domain used by the visible water specimen.
// This proves texture representation/readback, not production Water integration.
export async function probeWorldWaterField(device, values, width, height) {
  const texture = device.createTexture({ size: [width, height], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const bytes = values.byteLength;
  const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  device.pushErrorScope('validation');
  try {
    device.queue.writeTexture({ texture }, values, { bytesPerRow: width * 16 }, [width, height]);
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var domain: texture_2d<f32>;
      @group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
      @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) p: vec3<u32>) {
        let size = textureDimensions(domain);
        if (p.x >= size.x || p.y >= size.y) { return; }
        result[p.y * size.x + p.x] = textureLoad(domain, vec2<i32>(p.xy), 0);
      }` });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: texture.createView() }, { binding: 1, resource: { buffer: output } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(readback.getMappedRange()), expected = new Uint32Array(values.buffer, values.byteOffset, values.length);
    let differences = 0; for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) differences++;
    readback.unmap();
    if (differences) throw new Error(`Water domain GPU mismatch: ${differences} floats`);
    return { bytesCompared: bytes, differences, storageBuffers: 1, sampledTextures: 1 };
  } finally {
    const error = await device.popErrorScope(); texture.destroy(); output.destroy(); readback.destroy();
    if (error) throw new Error(`Water domain WebGPU validation: ${error.message}`);
  }
}
