/**
 * 分类规则匹配 —— 兼容 MoviePilot category.yaml 格式
 *
 * 规则说明：
 * - 同一分类内多个条件：全部满足（AND）
 * - 同一条件内多个值用逗号分隔：任意满足（OR）
 * - !值 表示排除该值（NOT）
 * - 空对象 {} 表示兜底（always match）
 * - 按声明顺序匹配，第一个命中的分类获胜
 */

function matchConditionValue(itemValues, conditionStr) {
    const values = String(conditionStr).split(',').map(v => v.trim());
    const items = Array.isArray(itemValues)
        ? itemValues.map(String)
        : [String(itemValues)];

    for (const v of values) {
        const negate = v.startsWith('!');
        const val = negate ? v.slice(1) : v;
        const found = items.some(i => i === val);
        if (negate && !found) return true;
        if (!negate && found) return true;
    }
    return false;
}

function matchesConditions(tmdbInfo, conditions) {
    if (!conditions || Object.keys(conditions).length === 0) return true; // {}兜底

    for (const [field, valueStr] of Object.entries(conditions)) {
        let itemValues;

        switch (field) {
            case 'genre_ids':
                itemValues = tmdbInfo.genreIds || [];
                break;
            case 'original_language':
                itemValues = tmdbInfo.originalLanguage || '';
                break;
            case 'origin_country':
            case 'production_countries':
                itemValues = tmdbInfo.originCountry || [];
                break;
            case 'release_year': {
                const year = parseInt(tmdbInfo.year);
                if (!year) return false;
                const s = String(valueStr);
                if (s.includes('-')) {
                    const [start, end] = s.split('-').map(y => parseInt(y));
                    if (!(year >= start && year <= end)) return false;
                } else {
                    if (year !== parseInt(s)) return false;
                }
                continue;
            }
            default:
                continue; // 未知字段跳过
        }

        if (!matchConditionValue(itemValues, valueStr)) return false;
    }
    return true;
}

/**
 * 匹配分类名称
 * @param {object} tmdbInfo 包含 isTV / genreIds / originalLanguage / originCountry / year
 * @param {object} rules    category.yaml 对应的 JSON 对象
 * @returns {string|null}   分类名称，无匹配返回 null
 */
function matchCategory(tmdbInfo, rules) {
    if (!rules) return null;
    const type = tmdbInfo.isTV ? 'tv' : 'movie';
    const typeRules = rules[type];
    if (!typeRules) return null;

    for (const [name, conditions] of Object.entries(typeRules)) {
        if (matchesConditions(tmdbInfo, conditions)) return name;
    }
    return null;
}

module.exports = { matchCategory };
