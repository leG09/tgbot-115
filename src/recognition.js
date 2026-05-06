const tmdbService = require('./tmdb');
const { recognizeWithAi } = require('./ai');
const { logRecognitionDiff } = require('./logger');

function titleSimilarity(a, b) {
    return tmdbService.titleSimilarity(a || '', b || '');
}

function buildUnverifiedInfo(aiResult, shareTitle) {
    return {
        tmdbId: null,
        title: aiResult.title || shareTitle,
        originalTitle: null,
        year: aiResult.year || null,
        overview: '',
        rating: null,
        isTV: aiResult.mediaType === 'tv',
        posterPath: null,
        genreIds: [],
        originalLanguage: '',
        originCountry: [],
        verified: false,
        verificationStatus: 'unverified',
        recognitionSource: aiResult.source,
        aiGuess: aiResult
    };
}

async function recognizeMedia(shareTitle, config) {
    const aiResult = await recognizeWithAi(shareTitle, config.ai);
    let tmdbInfo = null;
    try {
        tmdbInfo = await tmdbService.searchTmdbByGuess(aiResult, config.tmdb.apiKey, config.tmdb.language);
    } catch (_) {
        tmdbInfo = null;
    }

    if (!tmdbInfo) {
        return {
            finalInfo: buildUnverifiedInfo(aiResult, shareTitle),
            aiResult,
            tmdbInfo: null,
            usedFallback: true
        };
    }

    const sameType = (aiResult.mediaType === 'tv') === Boolean(tmdbInfo.isTV);
    const similarity = Math.max(
        titleSimilarity(aiResult.title, tmdbInfo.title),
        titleSimilarity(aiResult.title, tmdbInfo.originalTitle)
    );
    const consistent = sameType && similarity >= 0.55;
    const finalInfo = {
        ...tmdbInfo,
        verified: true,
        verificationStatus: consistent ? 'verified' : 'tmdb_override',
        recognitionSource: consistent ? 'ai+tmdb' : 'tmdb',
        aiGuess: aiResult
    };

    if (!consistent) {
        logRecognitionDiff({
            shareTitle,
            ai: aiResult,
            tmdb: {
                mediaType: tmdbInfo.isTV ? 'tv' : 'movie',
                title: tmdbInfo.title,
                originalTitle: tmdbInfo.originalTitle,
                year: tmdbInfo.year,
                tmdbId: tmdbInfo.tmdbId
            },
            resolvedBy: 'tmdb',
            similarity
        });
    }

    return {
        finalInfo,
        aiResult,
        tmdbInfo,
        usedFallback: false
    };
}

module.exports = {
    recognizeMedia
};
