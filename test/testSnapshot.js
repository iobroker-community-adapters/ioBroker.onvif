'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('mocha');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

// Exercise the adapter itself, stubbing only camera I/O and the ioBroker runtime.
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
// Complete, decodable 1x1 JPEG, including binary zero bytes.
const image = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyOiiiuw5D/9k=',
  'base64',
);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** @param {(...args: any[]) => Promise<any>} [request] */
function setup(request = async () => ({ status: 200, data: image })) {
  let now = 1000;
  const calls = [];
  class Adapter extends EventEmitter {
    constructor() {
      super();
      this.config = { useHighRes: false, serverPort: 0 };
      this.log = { debug() {}, info() {}, warn() {}, error() {} };
      this.setTimeout = setTimeout;
      this.clearTimeout = clearTimeout;
    }
  }
  const modules = {
    '@iobroker/adapter-core': { Adapter },
    urllib: {
      request: (...args) => {
        calls.push(args);
        return request(...args);
      },
    },
    json2iob: class {},
    onvif: {},
    xml2js: {},
    'node:util': require('node:util'),
    'node:http': http,
  };
  /** @type {any} */
  const context = {
    module: { exports: {} },
    Buffer,
    Date: { now: () => now },
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    },
  };
  vm.runInNewContext(source, context, { filename: 'main.js' });
  const adapter = context.module.exports();
  adapter.deviceNatives.c3 = { snapshotUrl: 'http://camera/c3', user: 'test', password: 'test' };
  adapter.deviceNatives.c4 = { snapshotUrl: 'http://camera/c4', user: 'test', password: 'test' };
  return {
    adapter,
    calls,
    advance: (ms) => {
      now += ms;
    },
  };
}
function fakeFfmpeg(adapter, run) {
  const commands = [];
  adapter.ffmpeg = (url) => {
    /** @type {any} */
    const command = new EventEmitter();
    command.url = url;
    command.inputOptions = () => command;
    command.addOptions = () => command;
    command.kill = () => {
      command.killed = true;
    };
    command.pipe = () => {
      const stream = new PassThrough();
      queueMicrotask(() => run(command, stream));
      return stream;
    };
    commands.push(command);
    return command;
  };
  return commands;
}
function get(port, camera) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/${camera}?_t=123`, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

describe('Snapshot concurrency and freshness', () => {
  it('shares a pending fetch even beyond 500 ms and retries immediately after a slow completion', async () => {
    const pending = deferred();
    const { adapter, calls, advance } = setup(() => pending.promise);
    const first = adapter.getSnapshot('c3');
    await Promise.resolve();
    advance(600);
    const second = adapter.getSnapshot('c3');
    pending.resolve({ status: 200, data: image });
    const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => result === image));
    assert.equal(calls.length, 1);
    await adapter.getSnapshot('c3');
    assert.equal(calls.length, 2);
  });

  it('reuses a successful buffer until exactly 500 ms from request start', async () => {
    const { adapter, calls, advance } = setup();
    assert.equal(await adapter.getSnapshot('c3'), image);
    advance(499);
    assert.equal(await adapter.getSnapshot('c3'), image);
    assert.equal(calls.length, 1);
    advance(1);
    await adapter.getSnapshot('c3');
    assert.equal(calls.length, 2);
  });

  it('allows different cameras to fetch independently', async () => {
    const pending = deferred();
    const { adapter, calls } = setup((url) => (url.endsWith('c3') ? pending.promise : Promise.resolve({ status: 200, data: image })));
    const first = adapter.getSnapshot('c3');
    assert.equal(await adapter.getSnapshot('c4'), image);
    assert.equal(calls.length, 2);
    pending.resolve({ status: 200, data: image });
    await first;
  });

  it('does not reuse a snapshot after replacing camera configuration', async () => {
    const { adapter, calls } = setup();
    await adapter.getSnapshot('c3');
    adapter.deviceNatives.c3 = { ...adapter.deviceNatives.c3, snapshotUrl: 'http://camera/new' };
    await adapter.getSnapshot('c3');
    assert.equal(calls.length, 2);
  });

  it('shares Basic-to-Digest authentication and bounds both requests', async () => {
    const { adapter, calls } = setup(async (_url, options) => ({ status: options.digestAuth ? 200 : 401, data: image }));
    const results = await Promise.all([adapter.getSnapshot('c3'), adapter.getSnapshot('c3')]);
    assert.ok(results.every((result) => result === image));
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1].timeout, 7000);
    assert.equal(calls[1][1].timeout, 7000);
    assert.equal(calls[1][1].digestAuth, 'test:test');
  });

  for (const mode of ['http', 'network', 'empty', 'digest']) {
    it(`does not cache ${mode} failures or return an expired image, and recovers`, async () => {
      let fail = false;
      const { adapter, advance } = setup(async (_url, options) => {
        if (!fail) return { status: 200, data: image };
        if (mode === 'network') throw new Error('ETIMEDOUT');
        if (mode === 'empty') return { status: 200, data: Buffer.alloc(0) };
        if (mode === 'digest' && !options.digestAuth) return { status: 401, data: Buffer.alloc(0) };
        return { status: 503, data: Buffer.from('unavailable') };
      });
      await adapter.getSnapshot('c3');
      advance(500);
      fail = true;
      assert.equal(await adapter.getSnapshot('c3'), undefined);
      fail = false;
      assert.equal(await adapter.getSnapshot('c3'), image);
    });
  }

  it('shares FFmpeg fallback, preserves binary chunks and selects high resolution', async () => {
    const { adapter } = setup();
    adapter.config.useHighRes = true;
    adapter.deviceNatives.c3.majorStreamUrl = 'rtsp://camera/main';
    const commands = fakeFfmpeg(adapter, (command, stream) => {
      stream.write(image.subarray(0, 4));
      stream.end(image.subarray(4));
      command.emit('end');
    });
    const results = await Promise.all([adapter.getSnapshot('c3'), adapter.getSnapshot('c3')]);
    results.forEach((result) => assert.deepEqual(result, image));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].url, 'rtsp://camera/main');
  });

  it('uses the minor stream when no snapshot URL exists', async () => {
    const { adapter } = setup();
    adapter.deviceNatives.c3 = { minorStreamUrl: 'rtsp://camera/sub' };
    const commands = fakeFfmpeg(adapter, (_command, stream) => stream.end(image));
    assert.deepEqual(await adapter.getSnapshot('c3'), image);
    assert.equal(commands[0].url, 'rtsp://camera/sub');
  });

  it('kills stalled FFmpeg work, releases all waiters and permits retry', async () => {
    const { adapter } = setup();
    adapter.deviceNatives.c3 = { minorStreamUrl: 'rtsp://camera/sub' };
    let expire;
    adapter.setTimeout = (callback, ms) => {
      assert.equal(ms, 15000);
      expire = callback;
      return 1;
    };
    adapter.clearTimeout = () => {};
    const commands = fakeFfmpeg(adapter, () => {});
    const results = Promise.allSettled([adapter.getSnapshot('c3'), adapter.getSnapshot('c3')]);
    await new Promise(setImmediate);
    expire();
    assert.ok((await results).every((result) => result.status === 'rejected'));
    assert.equal(commands[0].killed, true);
    fakeFfmpeg(adapter, (_command, stream) => stream.end(image));
    assert.deepEqual(await adapter.getSnapshot('c3'), image);
  });

  it('clears failed FFmpeg work for an immediate retry', async () => {
    const { adapter } = setup();
    adapter.deviceNatives.c3 = { minorStreamUrl: 'rtsp://camera/sub' };
    fakeFfmpeg(adapter, (command) => command.emit('error', new Error('camera offline')));
    await assert.rejects(adapter.getSnapshot('c3'), /camera offline/);
    fakeFfmpeg(adapter, (_command, stream) => stream.end(image));
    assert.deepEqual(await adapter.getSnapshot('c3'), image);
  });

  it('serves concurrent HTTP clients successfully and retains real failure/404 responses', async () => {
    let fail = false;
    const { adapter, calls, advance } = setup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: fail ? 503 : 200, data: image };
    });
    await adapter.startServer();
    if (!adapter.server.listening) await new Promise((resolve) => adapter.server.once('listening', resolve));
    const port = adapter.server.address().port;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => get(port, 'c3')));
      results.forEach((result) => {
        assert.equal(result.status, 200);
        assert.deepEqual(result.data, image);
      });
      assert.equal(calls.length, 1);
      assert.equal((await get(port, 'unknown')).status, 404);
      advance(500);
      fail = true;
      assert.equal((await get(port, 'c3')).status, 500);
      fail = false;
      assert.equal((await get(port, 'c3')).status, 200);
    } finally {
      await new Promise((resolve) => adapter.server.close(resolve));
    }
  });
});
