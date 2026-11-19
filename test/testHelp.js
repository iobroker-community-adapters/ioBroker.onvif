'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('mocha');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Load the adapter like testSnapshot.js, stubbing the ioBroker runtime and the camera libraries.
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/** The answer of the message "help" */
function askHelp() {
  const answers = [];
  class Adapter extends EventEmitter {
    constructor() {
      super();
      this.config = {};
      this.log = { debug() {}, info() {}, warn() {}, error() {} };
    }
    sendTo(from, command, message, callback) {
      answers.push({ from, command, message, callback });
    }
  }
  const modules = {
    '@iobroker/adapter-core': { Adapter },
    urllib: { request: async () => ({}) },
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
  return adapter.onMessage({ command: 'help', from: 'system.adapter.test.0', callback: { id: 1 } }).then(() => {
    assert.equal(answers.length, 1);
    assert.equal(answers[0].command, 'help');
    return answers[0].message;
  });
}

/** The commands onMessage answers: `obj.command === '...'`, without "send", which does nothing and answers nothing */
function commandsOfMain() {
  const start = source.indexOf('async onMessage(');
  const end = source.indexOf('async onStateChange(', start);
  assert.ok(start > 0 && end > start, 'onMessage found');
  return [...source.slice(start, end).matchAll(/obj\.command === '([^']+)'/g)].map((m) => m[1]).filter((c) => c !== 'send');
}

describe('help', () => {
  it('answers help and every command onMessage answers, each once', async () => {
    const { help, commands } = await askHelp();
    assert.equal(typeof help, 'string');
    const names = commands.map((c) => c.command);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual([...names].sort(), commandsOfMain().sort());
  });

  it('marks every command as write true or false and names it in the text', async () => {
    const { help, commands } = await askHelp();
    for (const { command, write } of commands) {
      assert.equal(typeof write, 'boolean', command);
      assert.ok(help.includes(command), command);
    }
    // only discover and manualSearch create devices
    // the answer comes from the context of the vm: copy it into an array of this one
    const writing = [...commands.filter((c) => c.write).map((c) => c.command)];
    assert.deepEqual(writing.sort(), ['discover', 'manualSearch']);
    assert.ok(help.includes('sendTo onvif.0'));
    assert.ok(help.includes('How to talk to the user:'));
  });

  it('keeps the lines short', async () => {
    const { help } = await askHelp();
    for (const line of help.split('\n')) {
      assert.ok(line.length <= 120, line);
    }
  });
});
