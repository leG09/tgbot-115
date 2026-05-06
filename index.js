const fs = require('fs');
const path = require('path');
const { createBot } = require('./src/bot');

const log = s => process.stderr.write(s + '\n');

// 加载配置文件
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    log('❌ 找不到 config.json，请复制 config.json.example 并填写配置');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

if (!config.telegram?.token) { log('❌ 缺少 telegram.token'); process.exit(1); }
if (!config.cookie115) { log('❌ 缺少 cookie115'); process.exit(1); }

const bot = createBot(config);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// bot.launch() 的第二个参数是 onLaunch 回调，在 getMe() 成功后、
// polling 循环开始前触发 —— 这是打印启动信息的正确位置
// launch() 本身会一直 await polling 循环，永不 resolve，所以 .then() 不适合用
bot.launch({}, () => {
    log('✅ 115转存机器人已启动');
    log(`📋 TMDB 语言: ${config.tmdb?.language || 'zh-CN'}`);
    log(`🧠 AI 识别: ${config.ai?.enabled ? '已启用' : '未启用（使用启发式识别）'}`);
    log(`🔗 Webhook: ${config.webhook?.url ? '已配置' : '未配置'}`);
    const ids = config.telegram?.allowedChatIds;
    if (ids?.length) log(`🔒 允许的群组/用户: ${ids.join(', ')}`);
    else log('⚠️  未限制来源，所有聊天均可使用');
}).catch(e => {
    log('❌ 启动失败: ' + e.message + '\n' + (e.stack || ''));
    process.exit(1);
});
