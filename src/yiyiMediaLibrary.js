const axios = require('axios');

function normalizeBaseUrl(baseURL) {
    return String(baseURL || '').replace(/\/+$/, '');
}

function buildHeaders(config = {}) {
    const headers = {};
    if (config.token) {
        headers['X-Admin-Token'] = config.token;
    }
    if (config.internalToken) {
        headers['X-Internal-Token'] = config.internalToken;
    }
    if (config.authorization) {
        headers.Authorization = config.authorization;
    }
    return headers;
}

function normalizeMediaType(tmdbInfo) {
    return tmdbInfo?.isTV ? 'series' : 'movie';
}

async function findFilesByTmdb(config, tmdbInfo) {
    if (!config?.baseURL) {
        return {
            enabled: false,
            exists: false,
            files: [],
            reason: 'YiYi baseURL 未配置'
        };
    }

    const tmdbId = Number(tmdbInfo?.tmdbId);
    if (!tmdbId) {
        return {
            enabled: true,
            exists: false,
            files: [],
            reason: 'TMDB ID 为空，无法查询 YiYi 媒体库'
        };
    }

    const mediaType = normalizeMediaType(tmdbInfo);
    const url = `${normalizeBaseUrl(config.baseURL)}/api/storage/metadata/files-by-tmdb`;
    const res = await axios.get(url, {
        timeout: config.timeoutMs || 8000,
        headers: buildHeaders(config),
        params: {
            mediaType,
            tmdbId,
            limit: config.limit || 50
        }
    });

    const files = Array.isArray(res.data) ? res.data : [];
    return {
        enabled: true,
        exists: files.length > 0,
        files,
        mediaType,
        tmdbId
    };
}

module.exports = {
    findFilesByTmdb
};
