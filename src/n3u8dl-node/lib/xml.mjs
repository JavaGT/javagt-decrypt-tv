import { DOMParser } from 'xmldom';

function getAttr(node, name) {
    if (!node || typeof node.getAttribute !== 'function') {
        return '';
    }
    return node.getAttribute(name) || '';
}

function isElementWithTagName(node, tagName) {
    if (!node || node.nodeType !== 1) {
        return false;
    }
    const name = node.localName || node.nodeName;
    return name === tagName;
}

function firstChildByTag(node, tagName) {
    if (!node?.childNodes) {
        return null;
    }

    for (const child of Array.from(node.childNodes)) {
        if (isElementWithTagName(child, tagName)) {
            return child;
        }
    }

    return null;
}

function textContent(node) {
    return node && typeof node.textContent === 'string' ? node.textContent.trim() : '';
}

function listChildrenByTag(node, tagName) {
    if (!node?.childNodes) {
        return [];
    }

    const matches = [];
    for (const child of Array.from(node.childNodes)) {
        if (isElementWithTagName(child, tagName)) {
            matches.push(child);
        }
    }

    return matches;
}

function resolveUrl(base, relative) {
    return new URL(relative, base).toString();
}

function parseDurationSeconds(isoValue) {
    if (!isoValue || typeof isoValue !== 'string') {
        return null;
    }
    const match = isoValue.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
    if (!match) {
        return null;
    }
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    return hours * 3600 + minutes * 60 + seconds;
}

export function parseXmlDocument(xmlText) {
    return new DOMParser().parseFromString(xmlText, 'application/xml');
}

export {
    getAttr,
    firstChildByTag,
    textContent,
    listChildrenByTag,
    resolveUrl,
    parseDurationSeconds
};
