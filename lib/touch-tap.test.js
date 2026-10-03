// node --test lib/touch-tap.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = vm.createContext();
vm.runInContext(`${fs.readFileSync(require('node:path').join(__dirname, 'touch-tap.js'), 'utf8')}\nglobalThis.__api = FMCTouchTap;`, ctx);
const { reduce, ARM_MS } = ctx.__api;

test('first tap on a cell previews and arms it', () => {
  const cell = {};
  const next = reduce(null, cell, 1000);
  assert.equal(next.action, 'preview');
  assert.equal(next.armed.el, cell);
  assert.equal(next.armed.until, 1000 + ARM_MS);
});

test('second tap on the same cell activates and disarms', () => {
  const cell = {};
  const armed = reduce(null, cell, 1000).armed;
  const next = reduce(armed, cell, 1000 + ARM_MS - 1);
  assert.equal(next.action, 'activate');
  assert.equal(next.armed, null);
});

test('a tap after the arm expires previews again', () => {
  const cell = {};
  const armed = reduce(null, cell, 1000).armed;
  const next = reduce(armed, cell, 1000 + ARM_MS);
  assert.equal(next.action, 'preview');
  assert.equal(next.armed.el, cell);
});

test('a tap on a different cell previews that cell', () => {
  const a = {};
  const b = {};
  const armed = reduce(null, a, 1000).armed;
  const next = reduce(armed, b, 1500);
  assert.equal(next.action, 'preview');
  assert.equal(next.armed.el, b);
});

test('after an activation the next tap previews again', () => {
  const cell = {};
  const armed = reduce(null, cell, 1000).armed;
  const activated = reduce(armed, cell, 2000);
  assert.equal(activated.action, 'activate');
  const again = reduce(activated.armed, cell, 2100);
  assert.equal(again.action, 'preview');
  assert.equal(again.armed.el, cell);
});
