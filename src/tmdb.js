/**
 * TMDB search module
 * 搜索逻辑参考 YiYi/YiYi-control-storage 的 MediaScrapeWorker.java
 */
const axios = require('axios');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_TIMEOUT = 8000;

// 噪声词正则，用于清洗标题（参考 YiYi MediaScrapeWorker）
const NOISE_PATTERNS = [
    /\b(2160p|1080p|1080i|720p|720i|576p|480p|4[Kk]|8[Kk]|UHD|FHD|HD)\b/g,
    /\b(AAC|DDP|DD\+|DTS[-\s]HD|DTS|TrueHD|Atmos|FLAC|AC3|E-AC3|5\.1|7\.1|2\.0)\b/gi,
    /\b(H\.?264|H\.?265|HEVC|AVC|x264|x265|VP9|AV1|xvid|divx|MPEG-?2)\b/gi,
    /\b(WEB[-\s]?DL|WEBRip|BluRay|BDRip|BDRIP|HDTV|REMUX|HDRip|DVDRip|CAMRip|PDVD)\b/gi,
    /\b(中字|外挂|双语|CHT|CHS|简繁|繁中|简中|内嵌|内封|字幕组)\b/g,
    /\b(MTEAM|PTER|CMCT|HDSky|CHDBits|TTG|OurBits|HDH|TJUPT|FGT|NTb|YIFY|YTS)\b/gi,
    /\b(HDR10\+?|HDR|Dolby\s?Vision|DV\b|HLG|SDR|DOVI)\b/gi,
    /\b(S\d{1,2}E\d{1,3}|E\d{1,3}|\d{1,2}x\d{1,3})\b/gi,
    /\bSeason\s*\d+\b/gi,
    /第\s*[\d一二三四五六七八九十百]+\s*季/g,
    /第\s*[\d一二三四五六七八九十百]+\s*[集话]/g,
    /\b(国语|粤语|英语|日语|韩语|法语|德语|普通话)\b/g,
    /【[^】]{0,40}】/g,
    /\[[^\]]{0,40}\]/g,
    /\([^)]{0,40}\)/g,
];

// TMDB ID 提取
const TMDB_ID_PATTERN = /(?:tmdb(?:id)?[-_=:\s：＝]*)([0-9]{2,10})/i;
// 年份提取
const YEAR_PATTERN = /(?<!\d)((?:19|20)\d{2})(?!\d)/;
// 剧集判断
const SEASON_PATTERN = /\b[Ss]\s*(\d{1,2})\b/;
const EPISODE_PATTERN = /\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\bE\d{1,3}\b/i;
const TV_CN_PATTERN = /第.+季|第.+话|第.+集|剧集|连续剧|电视剧/;
const NON_FEATURE_TITLE_PATTERN = /\b(soundtrack|score|music from|behind the scenes|trailer|featurette|making of)\b|制作特辑|幕后|预告/i;
const CN_PUNCTUATION_PATTERN = /[：:·,，!！?？()（）\[\]【】\-_.]/g;

async function tmdbGet(path, params) {
    return axios.get(`${TMDB_BASE}${path}`, {
        params,
        timeout: TMDB_TIMEOUT
    });
}

/**
 * 从原始分享标题解析影视名称
 * @param {string} raw 原始字符串
 * @returns {{ title: string, tmdbId: string|null, year: number|null, likelyTv: boolean }}
 */
function parseName(raw) {
    if (!raw) return { title: '', tmdbId: null, year: null, likelyTv: false };

    const tmdbMatch = raw.match(TMDB_ID_PATTERN);
    const tmdbId = tmdbMatch ? tmdbMatch[1] : null;

    const yearMatch = raw.match(YEAR_PATTERN);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    const likelyTv = SEASON_PATTERN.test(raw) || EPISODE_PATTERN.test(raw) || TV_CN_PATTERN.test(raw);

    let title = raw;

    // 去除 TMDB ID
    title = title.replace(/(?:tmdb(?:id)?[-_=:\s：＝]*)[0-9]{2,10}/gi, ' ');
    title = title.replace(/[{}]/g, ' ');
    // 去除年份
    title = title.replace(YEAR_PATTERN, ' ');
    // 去除各类噪声
    for (const p of NOISE_PATTERNS) {
        title = title.replace(p, ' ');
    }
    // 将点/下划线/连字符替换为空格（英文文件名常见）
    title = title.replace(/[._]+/g, ' ');
    // 合并多余空格
    title = title.replace(/\s+/g, ' ').trim();
    // 去除末尾的连字符/括号
    title = title.replace(/[-–—\s]+$/, '').trim();

    return { title, tmdbId, year, likelyTv };
}

/**
 * 标题相似度（LCS算法，参考 YiYi titleSimilarity）
 */
function titleSimilarity(a, b) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;

    const m = na.length, n = nb.length;
    // 超长字符串快速判断
    if (m > 200 || n > 200) {
        return na.includes(nb) || nb.includes(na) ? 0.8 : 0;
    }

    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = na[i - 1] === nb[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return (2.0 * dp[m][n]) / (m + n);
}

/**
 * 对 TMDB 搜索结果打分（参考 YiYi score()）
 */
function scoreResult(parsed, result, isTV) {
    let score = 0;
    const title = isTV
        ? (result.name || result.original_name || '')
        : (result.title || result.original_title || '');
    const originalTitle = isTV
        ? (result.original_name || result.name || '')
        : (result.original_title || result.title || '');
    const date = isTV ? result.first_air_date : result.release_date;
    const resultYear = date ? parseInt(date.substring(0, 4)) : null;

    const sim = Math.max(
        titleSimilarity(parsed.title, title),
        titleSimilarity(parsed.title, originalTitle)
    );
    if (sim >= 0.6) score += 100;
    else score += sim * 60;

    if (parsed.year && resultYear && parsed.year === resultYear) score += 30;
    if (parsed.likelyTv && isTV) score += 30;
    if (parsed.likelyTv && !isTV) score -= 80;
    if (!parsed.likelyTv && !isTV) score += 10;
    if (parsed.year && resultYear && Math.abs(parsed.year - resultYear) >= 2) score -= 20;
    if (NON_FEATURE_TITLE_PATTERN.test(title) || NON_FEATURE_TITLE_PATTERN.test(originalTitle)) score -= 60;

    return score;
}

async function performSearch(parsed, apiKey, language, useYear = true) {
    const commonParams = { api_key: apiKey, language, include_adult: false, page: 1 };

    return Promise.allSettled([
        tmdbGet('/search/movie', { ...commonParams, query: parsed.title, ...(useYear && parsed.year ? { year: parsed.year } : {}) }),
        tmdbGet('/search/tv', { ...commonParams, query: parsed.title, ...(useYear && parsed.year ? { first_air_date_year: parsed.year } : {}) })
    ]);
}

function simplifyChineseToken(token) {
    if (!token) return '';
    let value = token.trim();
    value = value.replace(/^(?:最后的|最后|终极|最终|特别篇|特别版|加长版|导演剪辑版)/, '');
    value = value.replace(/的/g, '');
    const digitChunk = value.match(/[0-9]+(?:[天日季集部篇])?/);
    if (digitChunk) {
        return digitChunk[0];
    }
    return value;
}

function buildQueryVariants(title) {
    const variants = new Set();
    const base = String(title || '').trim();
    if (!base) return [];

    variants.add(base);

    const normalized = base.replace(CN_PUNCTUATION_PATTERN, ' ').replace(/\s+/g, ' ').trim();
    if (normalized) variants.add(normalized);

    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        variants.add(`${parts[0]} ${parts[parts.length - 1]}`);
        const simplifiedLast = simplifyChineseToken(parts[parts.length - 1]);
        if (simplifiedLast) {
            variants.add(`${parts[0]} ${simplifiedLast}`);
        }
    }

    return [...variants];
}

/**
 * 根据分享标题搜索 TMDB
 * @returns {Promise<TmdbInfo|null>}
 */
async function searchTmdbByGuess(guess, apiKey, language = 'zh-CN') {
    const parsed = typeof guess === 'string'
        ? parseName(guess)
        : {
            title: guess?.title || '',
            tmdbId: guess?.tmdbId || null,
            year: guess?.year ? parseInt(guess.year) : null,
            likelyTv: guess?.mediaType === 'tv'
        };
    if (!parsed.title) return null;

    // 如果原始标题已含 TMDB ID，优先直接查询，避免搜索歧义
    if (parsed.tmdbId) {
        try {
            const [movieInfo, tvInfo] = await Promise.allSettled([
                getTmdbById(parsed.tmdbId, 'movie', apiKey, language),
                getTmdbById(parsed.tmdbId, 'tv', apiKey, language)
            ]);
            const info = movieInfo.status === 'fulfilled'
                ? movieInfo.value
                : (tvInfo.status === 'fulfilled' ? tvInfo.value : null);
            if (info) {
            // 相似度校验：如果匹配到的标题与解析标题差异过大，视为 ID 错误，fallback 到搜索
                const sim = titleSimilarity(parsed.title, info.title) ||
                            titleSimilarity(parsed.title, info.originalTitle || '');
                if (sim >= 0.3 || !parsed.title.replace(/[\s{}[\]()]/g, '')) return info;
            }
            // 相似度过低，忽略此 ID，继续关键词搜索
        } catch (e) { /* fallback to search */ }
    }

    const queryVariants = buildQueryVariants(parsed.title);

    for (const query of queryVariants) {
        for (const useYear of [true, false]) {
            const [movieRes, tvRes] = await performSearch({ ...parsed, title: query }, apiKey, language, useYear);

            let bestMovie = null, bestTv = null, bestMovieScore = -1, bestTvScore = -1;

            if (movieRes.status === 'fulfilled') {
                for (const r of (movieRes.value.data.results || []).slice(0, 8)) {
                    const s = scoreResult({ ...parsed, title: query }, r, false);
                    if (s > bestMovieScore) { bestMovieScore = s; bestMovie = r; }
                }
            }
            if (tvRes.status === 'fulfilled') {
                for (const r of (tvRes.value.data.results || []).slice(0, 8)) {
                    const s = scoreResult({ ...parsed, title: query }, r, true);
                    if (s > bestTvScore) { bestTvScore = s; bestTv = r; }
                }
            }

            if (!bestMovie && !bestTv) continue;

            const maxScore = Math.max(bestMovieScore, bestTvScore);
            if (maxScore < 30) continue;
            if (useYear && parsed.likelyTv && bestTvScore < 30) {
                continue;
            }

            const isTV = bestTvScore > bestMovieScore;
            if (parsed.likelyTv && !isTV) {
                continue;
            }
            const winner = isTV ? bestTv : bestMovie;

            return buildTmdbInfo(winner, isTV);
        }
    }

    return null;
}

async function searchTmdb(shareTitle, apiKey, language = 'zh-CN') {
    return searchTmdbByGuess(parseName(shareTitle), apiKey, language);
}

/**
 * 通过 TMDB ID 直接查询详情
 */
async function getTmdbById(tmdbId, type, apiKey, language = 'zh-CN') {
    const endpoint = type === 'tv' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
    const res = await tmdbGet(endpoint, { api_key: apiKey, language });
    if (!res.data || !res.data.id) {
        throw new Error('TMDB 未找到该ID');
    }
    return buildTmdbInfo(res.data, type === 'tv');
}

function buildTmdbInfo(data, isTV) {
    const date = isTV ? data.first_air_date : data.release_date;
    return {
        tmdbId: data.id,
        title: isTV ? (data.name || data.original_name) : (data.title || data.original_title),
        originalTitle: isTV ? data.original_name : data.original_title,
        year: date ? date.substring(0, 4) : null,
        overview: data.overview || '',
        rating: data.vote_average ? data.vote_average.toFixed(1) : null,
        isTV,
        posterPath: data.poster_path || null,
        // 分类所需字段
        genreIds: data.genre_ids || (data.genres?.map(g => g.id) || []),
        originalLanguage: data.original_language || '',
        // TV: origin_country 为字符串数组；Movie: production_countries 为对象数组，或直接取 origin_country
        originCountry: isTV
            ? (data.origin_country || [])
            : (data.production_countries?.map(c => c.iso_3166_1) || data.origin_country || []),
    };
}

module.exports = {
    searchTmdb,
    searchTmdbByGuess,
    getTmdbById,
    parseName,
    titleSimilarity
};
