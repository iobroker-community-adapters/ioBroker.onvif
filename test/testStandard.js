'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('mocha');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Load the adapter like testSnapshot.js, stubbing the ioBroker runtime and the camera libraries.
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 0xff, 0xd9]);

/** The adapter with two cameras: c3 connected, c4 only as a device; it records the answers of sendTo */
function setup() {
  const answers = [];
  class Adapter extends EventEmitter {
    constructor() {
      super();
      this.namespace = 'onvif.0';
      this.config = { useHighRes: false };
      this.log = { debug() {}, info() {}, warn() {}, error() {} };
      this.setTimeout = setTimeout;
      this.clearTimeout = clearTimeout;
    }
    sendTo(from, command, message) {
      answers.push(message);
    }
    async getDevicesAsync() {
      return [
        { _id: 'onvif.0.c3', common: { name: 'Reolink E1 192.168.1.3:80' }, native: {} },
        { _id: 'onvif.0.c4', common: { name: { en: 'Garden camera', de: 'Gartenkamera' } }, native: {} },
      ];
    }
    async getStatesAsync(pattern) {
      if (pattern === '*.connection') {
        return { 'onvif.0.c3.connection': { val: true }, 'onvif.0.c4.connection': { val: false } };
      }
      if (pattern === 'c3.infos.presets.*') {
        return { 'onvif.0.c3.infos.presets.Gate': { val: '2' }, 'onvif.0.c3.infos.presets.Terrace': { val: '1' } };
      }
      return {};
    }
  }
  const modules = {
    '@iobroker/adapter-core': { Adapter },
    urllib: { request: async () => ({ status: 200, data: image }) },
    json2iob: class {},
    onvif: {},
    xml2js: {},
    'node:util': require('node:util'),
    'node:http': require('node:http'),
  };
  /** @type {any} */
  const context = {
    module: { exports: {} },
    Buffer,
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    },
  };
  vm.runInNewContext(source, context, { filename: 'main.js' });
  const adapter = context.module.exports();
  adapter.deviceNatives.c3 = { snapshotUrl: 'http://camera/c3', user: 'test', password: 'test', ip: '192.168.1.3' };
  const moves = [];
  adapter.devices['192.168.1.3'] = {
    gotoPreset(options, callback) {
      moves.push(options.preset);
      callback(null, {});
    },
  };
  /** Send one message, return its answer as it arrives over the message bus (JSON) */
  const ask = async (command, message) => {
    answers.length = 0;
    await adapter.onMessage({ command, message, from: 'system.adapter.assistant.0', callback: { id: 1 } });
    assert.equal(answers.length, 1, `one answer to ${command}`);
    return JSON.parse(JSON.stringify(answers[0]));
  };
  return { adapter, ask, answers, moves };
}

describe('commands of the shared catalog', () => {
  it('getCameras lists the devices with their names and whether they answer', async () => {
    const { ask } = setup();
    assert.deepEqual(await ask('getCameras', {}), {
      cameras: [
        { id: 'c3', name: 'Reolink E1 192.168.1.3:80', online: true },
        { id: 'c4', name: 'Garden camera', online: false },
      ],
    });
    // also without a message
    assert.equal((await ask('getCameras')).cameras.length, 2);
  });

  it('snapshot {camera} answers {data, contentType}, the camera by id or name without case', async () => {
    const { ask } = setup();
    const expected = { data: image.toString('base64'), contentType: 'image/jpeg' };
    assert.deepEqual(await ask('snapshot', { camera: 'c3' }), expected);
    assert.deepEqual(await ask('snapshot', { camera: 'reolink' }), expected);
  });

  it('snapshot with the id as a string keeps answering the Buffer', async () => {
    const { ask } = setup();
    assert.deepEqual(await ask('snapshot', 'c3'), { type: 'Buffer', data: [...image] });
  });

  it('snapshot answers the errors of the catalog', async () => {
    const { ask } = setup();
    assert.deepEqual(await ask('snapshot', { camera: 'garden camera' }), {
      error: 'Camera "Garden camera" is not connected',
      reason: 'NOT_CONNECTED',
    });
    assert.deepEqual(await ask('snapshot', { camera: 'kitchen' }), {
      error: 'No camera "kitchen"',
      reason: 'NOT_FOUND',
      candidates: ['Reolink E1 192.168.1.3:80', 'Garden camera'],
    });
    assert.deepEqual(await ask('snapshot', { camera: 'c' }), {
      error: '"c" fits several, which camera?',
      reason: 'AMBIGUOUS',
      candidates: ['Reolink E1 192.168.1.3:80', 'Garden camera'],
    });
    assert.equal((await ask('snapshot', {})).reason, 'BAD_REQUEST');
    assert.equal((await ask('snapshot')).reason, 'BAD_REQUEST');
  });

  it('getPresets and gotoPreset by the name or the token of a preset', async () => {
    const { ask, adapter, answers, moves } = setup();
    assert.deepEqual(await ask('getPresets', { camera: 'c3' }), {
      presets: [
        { id: '2', name: 'Gate' },
        { id: '1', name: 'Terrace' },
      ],
    });
    assert.deepEqual(await ask('gotoPreset', { camera: 'c3', preset: 'gate' }), { ok: true });
    assert.deepEqual(await ask('gotoPreset', { camera: 'c3', preset: '1' }), { ok: true });
    assert.deepEqual(moves, ['2', '1']);
    assert.equal((await ask('gotoPreset', { camera: 'c3', preset: 'garage' })).reason, 'NOT_FOUND');
    assert.equal((await ask('gotoPreset', { camera: 'c3' })).reason, 'BAD_REQUEST');
    assert.equal((await ask('gotoPreset', { camera: 'c4', preset: '1' })).reason, 'NOT_CONNECTED');

    // it has an effect: it also runs without a callback
    answers.length = 0;
    await adapter.onMessage({ command: 'gotoPreset', message: { camera: 'c3', preset: 'Terrace' }, from: 'x' });
    assert.equal(answers.length, 0);
    assert.deepEqual(moves, ['2', '1', '1']);
  });
});
