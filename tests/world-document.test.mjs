import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldDocument, normalizeWorldDocument, patchWorldSettings, setWorldFeatureOverride,
  resetWorldFeatureOverride, captureWorldTerrainEdits, applyWorldTerrainEdits } from '../src/engine/world/worldDocument.js';

test('World documents are independent JSON values; partial settings preserve local edits and sibling controls', () => {
  const source = setWorldFeatureOverride(createWorldDocument(), 'cottage', 'roofColor', '#b92861');
  source.providerOverrides['foliage/oak'] = { type:'foliage', props:{ leafColor:'#518128' }, transform:{ position:[2,0,3] } };
  const next = patchWorldSettings(source, { geography:{ riverWidth:7 }, seed:120 });
  assert.equal(next.settings.geography.forestCover, .72);
  assert.equal(next.settings.geography.riverWidth, 7);
  assert.equal(next.edits[0].value, '#b92861');
  next.providerOverrides['foliage/oak'].props.leafColor = '#000000';
  assert.equal(source.providerOverrides['foliage/oak'].props.leafColor, '#518128');
  assert.deepEqual(normalizeWorldDocument(JSON.parse(JSON.stringify(source))), source);
  assert.equal(resetWorldFeatureOverride(next,'cottage','roofColor').edits.length, 0);
});

test('World rejects unsupported versions, non-JSON values and grids that cannot fit its recipe', () => {
  const invalid = [ {version:2}, {recipe:'absent'}, {settings:{seed:NaN}}, {settings:{seed:-1}},
    {settings:{geography:'bad'}}, {settings:{vegetation:[]}}, {settings:{groundDensitty:1}},
    {settings:{geography:{riverWidth:99}}}, {settings:{terrain:{style:'moon'}}}, {settings:{terrain:{levels:2.5}}}, {settings:{terrain:{macroShape:'valley'}}}, {settings:{settlement:{pattern:'sprawl'}}}, {settings:{extent:200}}, {settings:{style:'realistic'}}, {settings:{buildings:1}},
    {providerOverrides:{terrain:{type:'terrain',props:{resolution:128}}}},
    {providerOverrides:{terrain:{type:'terrain',props:{heights:'abc'}}}},
    {providerOverrides:{cottage:{type:'world-feature',transform:[1,2,3]}}},
    {resources:{materials:{ground:22}}}, {terrainEdits:{resolution:256,indices:[1,1],deltas:[2,2]}},
  ];
  for (const input of invalid) assert.throws(() => normalizeWorldDocument(input));
  let read = false;
  const getter = { get version() { read = true; return 1; } };
  assert.throws(() => normalizeWorldDocument(getter)); assert.equal(read,false);
  const cycle = {}; cycle.self=cycle; assert.throws(() => normalizeWorldDocument(cycle));
  assert.throws(() => normalizeWorldDocument({edits:new Array(2)}));
});

test('sculpt deltas exactly restore Float32 terrain and follow a changed procedural base', () => {
  const base = Float32Array.from({length:257**2}, (_,i) => Math.sin(i*.15)*4);
  const authored = new Float32Array(base);
  for (const i of [0,12,257,12001,base.length-1]) authored[i] += 3.157;
  const edits = captureWorldTerrainEdits(base, authored);
  assert.equal(edits.indices.length,5);
  assert.deepEqual(applyWorldTerrainEdits(base,edits),authored);
  const changed = Float32Array.from(base, value => value+2);
  const result = applyWorldTerrainEdits(changed,edits);
  for(let i=0;i<base.length;i++) assert.ok(Math.abs(result[i]-(authored[i]+2)) < 1e-6);
  assert.deepEqual(applyWorldTerrainEdits(base,null),base);
  assert.equal(captureWorldTerrainEdits(base,base),null);
});
