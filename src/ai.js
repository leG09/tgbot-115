const axios = require('axios');
const { parseName } = require('./tmdb');

const DEFAULT_SYSTEM_PROMPT = [
    '你是影视文件识别助手。',
    '请根据文件名或文件夹名，识别它更可能是电影还是剧集，并提取尽量干净的标题。',
    '只输出 JSON，不要输出 markdown。',
    '字段要求：',
    'mediaType: "movie" 或 "tv"',
    'title: 清洗后的标题',
    'year: 四位年份，没有则为 null',
    'confidence: 0 到 1 的数字',
    'reason: 简短说明'
].join('\n');

function heuristicRecognition(raw) {
    const parsed = parseName(raw);
    return {
        source: 'heuristic',
        mediaType: parsed.likelyTv ? 'tv' : 'movie',
        title: parsed.title || raw,
        tmdbId: parsed.tmdbId || null,
        year: parsed.year || null,
        confidence: parsed.title ? 0.45 : 0.2,
        reason: 'fallback heuristic'
    };
}

function extractJson(text) {
    if (!text) return null;
    const direct = text.trim();
    try {
        return JSON.parse(direct);
    } catch (_) {
        const match = direct.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch (_) {
            return null;
        }
    }
}

async function recognizeWithAi(raw, aiConfig = {}) {
    const parsedRaw = parseName(raw);
    if (!aiConfig?.enabled || !aiConfig?.apiKey || !aiConfig?.model || !aiConfig?.baseURL) {
        return heuristicRecognition(raw);
    }

    const url = `${String(aiConfig.baseURL).replace(/\/$/, '')}/chat/completions`;
    const res = await axios.post(url, {
        model: aiConfig.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: aiConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT },
            { role: 'user', content: raw }
        ]
    }, {
        timeout: aiConfig.timeoutMs || 15000,
        headers: {
            'Authorization': `Bearer ${aiConfig.apiKey}`,
            'Content-Type': 'application/json'
        }
    });

    const content = res.data?.choices?.[0]?.message?.content;
    const parsed = extractJson(content);
    if (!parsed?.title) {
        throw new Error('AI 识别返回格式无效');
    }

    return {
        source: 'ai',
        mediaType: parsed.mediaType === 'tv' ? 'tv' : 'movie',
        title: String(parsed.title).trim(),
        tmdbId: parsed.tmdbId || parsedRaw.tmdbId || null,
        year: parsed.year ? String(parsed.year).replace(/[^0-9]/g, '').slice(0, 4) || null : null,
        confidence: Number(parsed.confidence) || null,
        reason: parsed.reason || ''
    };
}

module.exports = {
    recognizeWithAi,
    heuristicRecognition
};
