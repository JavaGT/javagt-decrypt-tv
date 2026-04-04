import {
    parseXmlDocument,
    getAttr,
    firstChildByTag,
    textContent,
    listChildrenByTag,
    resolveUrl,
    parseDurationSeconds
} from './xml.mjs';
import {
    parseSelectionExpression,
    applySelectorFilters,
    selectItemsByMode
} from './selection.mjs';

function parseSegmentTimeline(segmentTemplateNode, timescale) {
    const timelineNode = firstChildByTag(segmentTemplateNode, 'SegmentTimeline');
    if (!timelineNode) {
        return null;
    }

    const points = [];
    let currentTime = 0;
    const entries = listChildrenByTag(timelineNode, 'S');

    for (const entry of entries) {
        const t = getAttr(entry, 't');
        const d = Number(getAttr(entry, 'd') || 0);
        const r = Number(getAttr(entry, 'r') || 0);
        if (!d) {
            continue;
        }

        currentTime = t ? Number(t) : currentTime;
        const repeatCount = r >= 0 ? r + 1 : 1;
        for (let i = 0; i < repeatCount; i += 1) {
            points.push(currentTime);
            currentTime += d;
        }
    }

    return {
        points,
        timescale
    };
}

function buildUrlsFromTemplate({
    manifestUrl,
    baseUrl,
    representationId,
    bandwidth,
    segmentTemplate,
    mediaPresentationDuration
}) {
    const startNumber = Number.isFinite(Number(segmentTemplate.startNumber))
        ? Number(segmentTemplate.startNumber)
        : 1;
    const timescale = Number.isFinite(Number(segmentTemplate.timescale)) && Number(segmentTemplate.timescale) > 0
        ? Number(segmentTemplate.timescale)
        : 1;
    const mediaTemplate = segmentTemplate.media;

    if (!mediaTemplate) {
        throw new Error(`Missing media template for representation ${representationId}`);
    }

    const timeline = parseSegmentTimeline(segmentTemplate.node, timescale);
    const segmentUrls = [];

    if (timeline && timeline.points.length) {
        for (let i = 0; i < timeline.points.length; i += 1) {
            const time = timeline.points[i];
            const url = mediaTemplate
                .replace(/\$RepresentationID\$/g, representationId)
                .replace(/\$Bandwidth\$/g, String(bandwidth || ''))
                .replace(/\$Time\$/g, String(time));
            segmentUrls.push(resolveUrl(baseUrl || manifestUrl, url));
        }
    } else {
        const duration = Number.isFinite(Number(segmentTemplate.duration))
            ? Number(segmentTemplate.duration)
            : 0;
        if (!duration || !mediaPresentationDuration) {
            throw new Error(`Unable to infer segment count for representation ${representationId}`);
        }
        const segDurationSeconds = duration / timescale;
        const totalSegments = Math.max(1, Math.ceil(mediaPresentationDuration / segDurationSeconds));

        for (let i = 0; i < totalSegments; i += 1) {
            const number = startNumber + i;
            const url = mediaTemplate
                .replace(/\$RepresentationID\$/g, representationId)
                .replace(/\$Bandwidth\$/g, String(bandwidth || ''))
                .replace(/\$Number%0(\d+)d\$/g, (_, width) => String(number).padStart(Number(width), '0'))
                .replace(/\$Number\$/g, String(number));
            segmentUrls.push(resolveUrl(baseUrl || manifestUrl, url));
        }
    }

    const initializationTemplate = segmentTemplate.initialization || '';
    const initializationUrl = initializationTemplate
        ? resolveUrl(
            baseUrl || manifestUrl,
            initializationTemplate
                .replace(/\$RepresentationID\$/g, representationId)
                .replace(/\$Bandwidth\$/g, String(bandwidth || ''))
        )
        : null;

    return {
        initializationUrl,
        segmentUrls
    };
}

function scoreRepresentation(rep, kind) {
    const bandwidth = Number(rep.bandwidth || 0);
    const height = Number(rep.height || 0);
    if (kind === 'video') {
        return height * 1000000 + bandwidth;
    }
    return bandwidth;
}

function pickRepresentation(representations, kind, selection) {
    if (!representations.length) {
        return null;
    }

    const selector = parseSelectionExpression(selection);
    const filtered = applySelectorFilters(representations, selector);
    const pool = filtered.length ? filtered : representations;
    return selectItemsByMode(pool, selector, (item) => scoreRepresentation(item, kind))[0] || null;
}

function pickTextTracks(tracks, selection) {
    if (!tracks.length) {
        return [];
    }

    const selector = parseSelectionExpression(selection);
    const filtered = applySelectorFilters(tracks, selector);
    const pool = filtered.length ? filtered : tracks;
    return selectItemsByMode(pool, selector, () => 1);
}

function getNodeLocalBaseUrl(node) {
    const baseNode = firstChildByTag(node, 'BaseURL');
    return baseNode ? textContent(baseNode) : '';
}

function resolveBaseChain(manifestUrl, parts) {
    let current = manifestUrl;
    for (const part of parts) {
        if (!part) {
            continue;
        }
        current = resolveUrl(current, part);
    }
    return current;
}

export function parseMpdManifest({ manifestUrl, manifestText, selectVideo = 'best', selectAudio = 'best', selectSubtitle = 'all' }) {
    const doc = parseXmlDocument(manifestText);
    const mpdNode = doc.documentElement;
    if (!mpdNode || mpdNode.nodeName !== 'MPD') {
        throw new Error('Invalid MPD document');
    }

    const periods = listChildrenByTag(mpdNode, 'Period');
    if (!periods.length) {
        throw new Error('MPD contains no Period nodes');
    }

    const periodNode = periods[0];
    const adaptationSets = listChildrenByTag(periodNode, 'AdaptationSet');
    const mediaPresentationDuration = parseDurationSeconds(getAttr(mpdNode, 'mediaPresentationDuration'));

    const mpdBase = getNodeLocalBaseUrl(mpdNode);
    const periodBase = getNodeLocalBaseUrl(periodNode);

    const streams = {
        video: [],
        audio: [],
        subtitle: []
    };

    for (const adaptation of adaptationSets) {
        const mimeType = getAttr(adaptation, 'mimeType');
        const contentType = getAttr(adaptation, 'contentType');
        const type = contentType || (mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : mimeType.startsWith('text/') ? 'text' : mimeType.includes('ttml') ? 'text' : 'other');
        if (type !== 'video' && type !== 'audio' && type !== 'text') {
            continue;
        }

        const adaptationBase = getNodeLocalBaseUrl(adaptation);
        const adaptationTemplate = firstChildByTag(adaptation, 'SegmentTemplate');
        const representations = listChildrenByTag(adaptation, 'Representation');

        for (const representation of representations) {
            const representationBase = getNodeLocalBaseUrl(representation);
            const representationTemplate = firstChildByTag(representation, 'SegmentTemplate');
            const templateNode = representationTemplate || adaptationTemplate;
            if (type !== 'text' && !templateNode) {
                continue;
            }

            const baseUrl = resolveBaseChain(manifestUrl, [mpdBase, periodBase, adaptationBase, representationBase]);

            const rep = {
                id: getAttr(representation, 'id') || `${type}-${streams[type].length + 1}`,
                bandwidth: Number(getAttr(representation, 'bandwidth') || 0),
                height: Number(getAttr(representation, 'height') || 0),
                width: Number(getAttr(representation, 'width') || 0),
                codecs: getAttr(representation, 'codecs') || getAttr(adaptation, 'codecs') || '',
                language: getAttr(adaptation, 'lang') || '',
                baseUrl,
                mimeType
            };

            if (type !== 'text') {
                rep.segmentTemplate = {
                    node: templateNode,
                    media: getAttr(templateNode, 'media'),
                    initialization: getAttr(templateNode, 'initialization'),
                    timescale: Number(getAttr(templateNode, 'timescale') || 1),
                    duration: Number(getAttr(templateNode, 'duration') || 0),
                    startNumber: Number(getAttr(templateNode, 'startNumber') || 1)
                };
            }

            if (type === 'text') {
                rep.subtitleUrl = baseUrl;
                rep.kind = 'subtitle';
                streams.subtitle.push(rep);
            } else {
                streams[type].push(rep);
            }
        }
    }

    const selectedVideo = pickRepresentation(streams.video, 'video', selectVideo);
    const selectedAudio = pickRepresentation(streams.audio, 'audio', selectAudio);
    const selectedSubtitles = pickTextTracks(streams.subtitle, selectSubtitle);

    if (!selectedVideo && !selectedAudio && !selectedSubtitles.length) {
        throw new Error('No supported video/audio representations found in MPD');
    }

    const selected = {
        video: selectedVideo
            ? {
                ...selectedVideo,
                ...buildUrlsFromTemplate({
                    manifestUrl,
                    baseUrl: selectedVideo.baseUrl,
                    representationId: selectedVideo.id,
                    bandwidth: selectedVideo.bandwidth,
                    segmentTemplate: selectedVideo.segmentTemplate,
                    mediaPresentationDuration
                })
            }
            : null,
        audio: selectedAudio
            ? {
                ...selectedAudio,
                ...buildUrlsFromTemplate({
                    manifestUrl,
                    baseUrl: selectedAudio.baseUrl,
                    representationId: selectedAudio.id,
                    bandwidth: selectedAudio.bandwidth,
                    segmentTemplate: selectedAudio.segmentTemplate,
                    mediaPresentationDuration
                })
            }
            : null,
        subtitles: selectedSubtitles.map((subtitle) => ({
            ...subtitle,
            subtitleUrl: subtitle.subtitleUrl,
            isDirectFile: true
        }))
    };

    return {
        mediaPresentationDuration,
        selected,
        representations: streams
    };
}

export default {
    parseMpdManifest
};
