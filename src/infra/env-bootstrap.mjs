import dotenv from 'dotenv';

let environmentLoaded = false;

export function ensureEnvironmentLoaded() {
    if (!environmentLoaded) {
        dotenv.config();
        environmentLoaded = true;
        return true;
    }
    return false;
}

export function isEnvironmentLoaded() {
    return environmentLoaded;
}

export function _resetEnvironmentBootstrapForTests() {
    environmentLoaded = false;
}

export default {
    ensureEnvironmentLoaded,
    isEnvironmentLoaded,
    _resetEnvironmentBootstrapForTests
};
