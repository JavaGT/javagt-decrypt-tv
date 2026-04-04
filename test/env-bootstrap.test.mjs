import assert from 'node:assert/strict';
import test from 'node:test';
import {
    _resetEnvironmentBootstrapForTests,
    ensureEnvironmentLoaded,
    isEnvironmentLoaded
} from '../src/infra/env-bootstrap.mjs';

test('environment bootstrap loads once', () => {
    _resetEnvironmentBootstrapForTests();

    const first = ensureEnvironmentLoaded();
    const second = ensureEnvironmentLoaded();

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(isEnvironmentLoaded(), true);
});

test('environment bootstrap reset helper clears loaded flag', () => {
    _resetEnvironmentBootstrapForTests();
    assert.equal(isEnvironmentLoaded(), false);
});
