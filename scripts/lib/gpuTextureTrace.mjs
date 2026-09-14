/** Optional test instrumentation; records the native binding of retired textures. */
export function installGPUTextureTrace() {
  Error.stackTraceLimit = 30;
  globalThis.__reloadTrace = { destroyed: [], stale: [] };
  if (!globalThis.GPUDevice) return;
  const views = new WeakMap(), groups = new WeakMap(), dead = new WeakMap(), encoders = new WeakMap(), passes = new WeakMap(), commands = new WeakMap();
  globalThis.__reloadInspectGroup = group => (groups.get(group) ?? []).filter(texture => dead.has(texture)).map(texture => dead.get(texture));
  const wrap = (prototype, name, fn) => { const original = prototype[name]; prototype[name] = function (...args) { return fn.call(this, original, args); }; };
  wrap(GPUTexture.prototype, 'createView', function (original, args) {
    const view = original.apply(this, args); views.set(view, this); return view;
  });
  wrap(GPUTexture.prototype, 'destroy', function (original, args) {
    const record = { label: this.label, at: performance.now(), stack: new Error().stack };
    dead.set(this, record); if (/Shadow/.test(this.label)) __reloadTrace.destroyed.push(record);
    return original.apply(this, args);
  });
  wrap(GPUDevice.prototype, 'createBindGroup', function (original, args) {
    const group = original.apply(this, args);
    groups.set(group, args[0].entries.map(entry => views.get(entry.resource)).filter(Boolean)); return group;
  });
  wrap(GPURenderPassEncoder.prototype, 'setBindGroup', function (original, args) {
    const textures = groups.get(args[1]) ?? [];
    for (const texture of textures) passes.get(this)?.add(texture);
    const stale = textures.filter(texture => dead.has(texture));
    if (stale.length && __reloadTrace.stale.length < 25) __reloadTrace.stale.push({ at: performance.now(), stack: new Error().stack, textures: stale.map(texture => dead.get(texture)) });
    return original.apply(this, args);
  });
  wrap(GPUCommandEncoder.prototype, 'beginRenderPass', function (original, args) {
    const textures = encoders.get(this) ?? new Set(); encoders.set(this, textures);
    const descriptor = args[0];
    for (const attachment of [...descriptor.colorAttachments, descriptor.depthStencilAttachment].filter(Boolean)) {
      for (const view of [attachment.view, attachment.resolveTarget]) if (views.has(view)) textures.add(views.get(view));
    }
    const pass = original.apply(this, args); passes.set(pass, textures); return pass;
  });
  wrap(GPUCommandEncoder.prototype, 'finish', function (original, args) {
    const command = original.apply(this, args); commands.set(command, encoders.get(this)); return command;
  });
  wrap(GPUQueue.prototype, 'submit', function (original, args) {
    for (const command of args[0]) {
      const stale = [...(commands.get(command) ?? [])].filter(texture => dead.has(texture));
      if (stale.length && __reloadTrace.stale.length < 25) __reloadTrace.stale.push({ submit: true, at: performance.now(), stack: new Error().stack, textures: stale.map(texture => dead.get(texture)) });
    }
    return original.apply(this, args);
  });
}
