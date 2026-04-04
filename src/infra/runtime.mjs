import { DOMParser } from 'xmldom';
import { Cdm } from '../pywidevine-node/Cdm.mjs';
import { Device } from '../pywidevine-node/Device.mjs';
import { PSSH } from '../pywidevine-node/Pssh.mjs';
import { fetchJson, fetchText, createTimeoutSignal } from './http-client.mjs';
import {
    extractManifestWidevineData,
    fetchBrightcovePlayback,
    fetchManifestWidevineData,
    getWidevineKeys,
    selectPlaybackManifest
} from './brightcove-media.mjs';

export function createDefaultRuntime() {
    return {
        DOMParser,
        Cdm,
        Device,
        PSSH,
        fetchJson,
        fetchText,
        createTimeoutSignal,
        extractManifestWidevineData,
        fetchBrightcovePlayback,
        fetchManifestWidevineData,
        getWidevineKeys,
        selectPlaybackManifest
    };
}

export default createDefaultRuntime;