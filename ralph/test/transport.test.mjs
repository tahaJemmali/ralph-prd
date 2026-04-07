import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TransportError, getCumulativeCost, _addCost, _resetCost } from '../lib/transport.mjs';

describe('TransportError', () => {

  test('has correct name', () => {
    const err = new TransportError('something went wrong', 'auth');
    assert.equal(err.name, 'TransportError');
  });

  test('is an instance of Error', () => {
    const err = new TransportError('msg', 'timeout');
    assert.ok(err instanceof Error);
  });

  test('carries message and type', () => {
    const err = new TransportError('auth failure', 'auth');
    assert.equal(err.message, 'auth failure');
    assert.equal(err.type, 'auth');
  });

  test('type can be auth | timeout | response | network | parse', () => {
    for (const type of ['auth', 'timeout', 'response', 'network', 'parse']) {
      const err = new TransportError('msg', type);
      assert.equal(err.type, type);
    }
  });

});


describe('getCumulativeCost', () => {

  test('initial cost is 0 (after reset)', () => {
    _resetCost();
    assert.equal(getCumulativeCost(), 0);
  });

  test('accumulates cost across multiple additions', () => {
    _resetCost();
    _addCost(0.001);
    _addCost(0.002);
    assert.ok(
      Math.abs(getCumulativeCost() - 0.003) < 1e-9,
      `Expected 0.003, got ${getCumulativeCost()}`
    );
  });

  test('returns a number', () => {
    _resetCost();
    assert.equal(typeof getCumulativeCost(), 'number');
  });

  test('reset brings cost back to 0', () => {
    _addCost(1.23);
    _resetCost();
    assert.equal(getCumulativeCost(), 0);
  });

});

// Note: preflight() and send() require a live Claude session (macOS Keychain).
// The test below verifies that missing credentials surface as TransportError
// of type 'auth'.  It will PASS on an authenticated machine and may also pass
// on an unauthenticated machine (where no credentials exist).
describe('transport integration', () => {

  test('preflight() resolves or throws TransportError (never crashes process)', async () => {
    const { preflight } = await import('../lib/transport.mjs');
    try {
      await preflight();
      // Authenticated machine: preflight passed — that's fine
    } catch (err) {
      // Unauthenticated: must be a TransportError
      assert.ok(
        err instanceof TransportError,
        `Expected TransportError, got ${err.constructor.name}: ${err.message}`
      );
      assert.ok(
        ['auth', 'timeout', 'network'].includes(err.type),
        `Unexpected error type: ${err.type}`
      );
    }
  });

});
