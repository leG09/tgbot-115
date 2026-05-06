/**
 * 分类规则匹配 —— 兼容 MoviePilot category.yaml 格式
 *
 * 规则说明：
 * - 同一分类内多个条件：全部满足（AND）
 * - 同一条件内多个值用逗号分隔：任意满足（OR）
 * - !值 表示排除该值（NOT）
 * - 空对象 {} 表示兜底（always match）
 * - 若多个分类同时命中，优先选择条件更多、更具体的规则
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

function calcRuleSpecificity(conditions) {
    if (!conditions || Object.keys(conditions).length === 0) return 0;

    let score = 0;
    for (const value of Object.values(conditions)) {
        const values = String(value).split(',').map(v => v.trim()).filter(Boolean);
        // 条件字段越多越具体；单字段可选值越少也越具体
        score += 100;
        score += Math.max(0, 10 - values.length);
    }
    return score;
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

    let best = null;
    for (const [name, conditions] of Object.entries(typeRules)) {
        if (!matchesConditions(tmdbInfo, conditions)) continue;

        const candidate = {
            name,
            specificity: calcRuleSpecificity(conditions)
        };

        if (!best || candidate.specificity > best.specificity) {
            best = candidate;
        }
    }
    return best?.name || null;
}

module.exports = { matchCategory };
