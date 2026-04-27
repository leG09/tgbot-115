/**
 * TMDB search module
 * 搜索逻辑参考 YiYi/YiYi-control-storage 的 MediaScrapeWorker.java
 */
const axios = require('axios');

const TMDB_BASE = 'https://api.themoviedb.org/3';

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
const TV_CN_PATTERN = /第.+季|第.+话|第.+集|剧集|连续剧|电视剧/;

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

    const likelyTv = SEASON_PATTERN.test(raw) || TV_CN_PATTERN.test(raw);

    let title = raw;

    // 去除 TMDB ID
    title = title.replace(/(?:tmdb(?:id)?[-_=:\s：＝]*)[0-9]{2,10}/gi, ' ');
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
    const date = isTV ? result.first_air_date : result.release_date;
    const resultYear = date ? parseInt(date.substring(0, 4)) : null;

    const sim = titleSimilarity(parsed.title, title);
    if (sim >= 0.6) score += 100;
    else score += sim * 60;

    if (parsed.year && resultYear && parsed.year === resultYear) score += 30;
    if (parsed.likelyTv && isTV) score += 30;
    if (!parsed.likelyTv && !isTV) score += 10;

    return score;
}

/**
 * 根据分享标题搜索 TMDB
 * @returns {Promise<TmdbInfo|null>}
 */
async function searchTmdb(shareTitle, apiKey, language = 'zh-CN') {
    const parsed = parseName(shareTitle);
    if (!parsed.title) return null;

    // 如果原始标题已含 TMDB ID，直接查询，但需校验标题相似度防止 ID 错误
    if (parsed.tmdbId) {
        try {
            const info = await getTmdbById(parsed.tmdbId, 'movie', apiKey, language)
                .catch(() => getTmdbById(parsed.tmdbId, 'tv', apiKey, language));
            // 相似度校验：如果匹配到的标题与解析标题差异过大，视为 ID 错误，fallback 到搜索
            const sim = titleSimilarity(parsed.title, info.title) ||
                        titleSimilarity(parsed.title, info.originalTitle || '');
            if (sim >= 0.3) return info;
            // 相似度过低，忽略此 ID，继续关键词搜索
        } catch (e) { /* fallback to search */ }
    }

    const commonParams = { api_key: apiKey, language, include_adult: false, page: 1 };

    const [movieRes, tvRes] = await Promise.allSettled([
        axios.get(`${TMDB_BASE}/search/movie`, {
            params: { ...commonParams, query: parsed.title, ...(parsed.year ? { year: parsed.year } : {}) }
        }),
        axios.get(`${TMDB_BASE}/search/tv`, {
            params: { ...commonParams, query: parsed.title, ...(parsed.year ? { first_air_date_year: parsed.year } : {}) }
        })
    ]);

    let bestMovie = null, bestTv = null, bestMovieScore = -1, bestTvScore = -1;

    if (movieRes.status === 'fulfilled') {
        for (const r of (movieRes.value.data.results || []).slice(0, 5)) {
            const s = scoreResult(parsed, r, false);
            if (s > bestMovieScore) { bestMovieScore = s; bestMovie = r; }
        }
    }
    if (tvRes.status === 'fulfilled') {
        for (const r of (tvRes.value.data.results || []).slice(0, 5)) {
            const s = scoreResult(parsed, r, true);
            if (s > bestTvScore) { bestTvScore = s; bestTv = r; }
        }
    }

    if (!bestMovie && !bestTv) return null;

    // 分数过低则认为未匹配
    const maxScore = Math.max(bestMovieScore, bestTvScore);
    if (maxScore < 30) return null;

    const isTV = bestTvScore > bestMovieScore;
    const winner = isTV ? bestTv : bestMovie;

    return buildTmdbInfo(winner, isTV);
}

/**
 * 通过 TMDB ID 直接查询详情
 */
async function getTmdbById(tmdbId, type, apiKey, language = 'zh-CN') {
    const endpoint = type === 'tv' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
    const res = await axios.get(`${TMDB_BASE}${endpoint}`, {
        params: { api_key: apiKey, language }
    });
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

module.exports = { searchTmdb, getTmdbById, parseName };
