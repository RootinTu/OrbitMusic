const MAX_SURFACES = 32;

const SHADER = /* wgsl */ `
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var glassTexture: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> settings: array<vec4f>;

struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn screenTriangle(@builtin(vertex_index) index: u32) -> Vertex {
  let corners = array(vec2f(-1, -1), vec2f(-1, 3), vec2f(3, -1));
  let point = corners[index];
  return Vertex(vec4f(point, 0, 1), vec2f(point.x + 1, 1 - point.y) * 0.5);
}

@fragment
fn prepareBackdrop(in: Vertex) -> @location(0) vec4f {
  let terrain = textureSampleLevel(sourceTexture, linearSampler, in.uv, 0);
  let backdrop = vec3f(16, 17, 19) / 255.0;
  return vec4f(mix(backdrop, terrain.rgb, terrain.a * settings[0].z), 1);
}

@fragment
fn presentGlass(in: Vertex) -> @location(0) vec4f {
  let liveDom = textureSampleLevel(sourceTexture, linearSampler, in.uv * settings[0].xy, 0);
  let foreground = vec4f(liveDom.rgb * liveDom.a, liveDom.a);
  let glass = textureSampleLevel(glassTexture, linearSampler, in.uv, 0);
  var coverage = 0.0;
  for (var i = 0u; i < u32(settings[0].w); i++) {
    let rect = settings[1u + i * 2u];
    let radius = settings[2u + i * 2u].x;
    let halfSize = rect.zw * 0.5;
    let q = abs(in.position.xy - rect.xy - halfSize) - halfSize + vec2f(radius);
    let distance = length(max(q, vec2f(0))) + min(max(q.x, q.y), 0) - radius;
    coverage = max(coverage, 1.0 - smoothstep(-0.5, 1.5, distance));
  }
  return mix(foreground, glass, coverage);
}
`;

// Keep the live terrain visible directly through the transparent WebGPU
// surface. A copy is used only as the input to the glass refraction.
export function createGlassPresentation(device, format) {
  const shader = device.createShaderModule({ code: SHADER });
  const pipelineFor = entryPoint => device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'screenTriangle' },
    fragment: { module: shader, entryPoint, targets: [{ format }] },
  });
  const preparePipeline = pipelineFor('prepareBackdrop');
  const presentPipeline = pipelineFor('presentGlass');
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const values = new Float32Array(4 + MAX_SURFACES * 8);
  const settings = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const targetUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
  let terrainTexture, baseTexture, glassTexture;

  function render(pipeline, textures, destination) {
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        ...textures.map((texture, index) => ({ binding: index + 1, resource: texture.createView() })),
        { binding: 3, resource: { buffer: settings } },
      ],
    });
    const commands = device.createCommandEncoder();
    const pass = commands.beginRenderPass({
      colorAttachments: [{ view: destination.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([commands.finish()]);
  }

  function resize(width, height) {
    baseTexture?.destroy();
    glassTexture?.destroy();
    baseTexture = device.createTexture({ size: [width, height], format, usage: targetUsage });
    glassTexture = device.createTexture({ size: [width, height], format, usage: targetUsage });
  }

  function prepare(canvas, opacity) {
    const width = canvas?.width || 1;
    const height = canvas?.height || 1;
    if (terrainTexture?.width !== width || terrainTexture?.height !== height) {
      terrainTexture?.destroy();
      terrainTexture = device.createTexture({
        size: [width, height], format: 'rgba8unorm', usage: targetUsage | GPUTextureUsage.COPY_DST,
      });
    }
    if (canvas && opacity > 0) device.queue.copyExternalImageToTexture({ source: canvas }, { texture: terrainTexture }, [width, height]);
    values[2] = opacity;
    device.queue.writeBuffer(settings, 0, values.subarray(0, 4));
    render(preparePipeline, [terrainTexture], baseTexture);
    return { backdropTexture: baseTexture, outputTexture: glassTexture };
  }

  function present(entry, output, layouts, dpr) {
    values[0] = entry.copiedDeviceWidth / entry.textureWidth;
    values[1] = entry.copiedDeviceHeight / entry.textureHeight;
    values[3] = Math.min(MAX_SURFACES, layouts.length);
    for (let index = 0; index < values[3]; index++) {
      const { x, y, width, height, cornerRadius } = layouts[index];
      values.set([x * dpr, y * dpr, width * dpr, height * dpr, cornerRadius * dpr], 4 + index * 8);
    }
    device.queue.writeBuffer(settings, 0, values.subarray(0, 4 + values[3] * 8));
    render(presentPipeline, [entry.texture, glassTexture], output);
  }

  function destroy() {
    terrainTexture?.destroy();
    baseTexture?.destroy();
    glassTexture?.destroy();
    settings.destroy();
  }

  return { resize, prepare, present, destroy };
}
