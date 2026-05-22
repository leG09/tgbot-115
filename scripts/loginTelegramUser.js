const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function readConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`找不到配置文件: ${CONFIG_PATH}`);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function createPrompt() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return {
        ask(question) {
            return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
        },
        close() {
            rl.close();
        }
    };
}

function isError(error, name) {
    const message = String(error?.errorMessage || error?.message || error || '');
    return message.includes(name);
}

function parseFloodSeconds(error) {
    const fields = [
        error?.seconds,
        error?.errorMessage,
        error?.message,
        String(error || '')
    ];
    for (const field of fields) {
        if (typeof field === 'number' && Number.isFinite(field)) {
            return field;
        }
        const match = String(field || '').match(/FLOOD_WAIT_?(\d+)|wait of (\d+) seconds/i);
        if (match) {
            return Number(match[1] || match[2]);
        }
    }
    return null;
}

function formatSeconds(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes <= 0) return `${seconds} 秒`;
    return `${minutes} 分 ${rest} 秒`;
}

function describeTelegramError(error) {
    const fields = {
        name: error?.name,
        className: error?.className,
        code: error?.code,
        errorMessage: error?.errorMessage,
        message: error?.message,
        seconds: error?.seconds
    };
    const details = Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}: ${value}`);
    if (!details.length) {
        details.push(`raw: ${String(error)}`);
    }

    const floodSeconds = parseFloodSeconds(error);
    if (floodSeconds !== null) {
        details.push(`floodWait: ${formatSeconds(floodSeconds)} (${floodSeconds} 秒)`);
    }
    return details.join('\n');
}

function printLoginHint() {
    console.log('Telegram 用户账号登录');
    console.log('验证码只会提交一次；如果输错，脚本会退出，不会自动重试。');
    console.log('');
}

async function main() {
    const config = readConfig();
    const tg = config.telegramUser || {};
    if (!tg.apiId || !tg.apiHash) {
        throw new Error('缺少 telegramUser.apiId 或 telegramUser.apiHash');
    }

    printLoginHint();
    const prompt = createPrompt();
    const client = new TelegramClient(new StringSession(''), Number(tg.apiId), tg.apiHash, {
        connectionRetries: 3
    });

    try {
        const defaultPhone = tg.phoneNumber || '';
        const phoneInput = await prompt.ask(defaultPhone
            ? `手机号（回车使用 ${defaultPhone}）: `
            : '手机号（带国家区号，例如 +8613800138000）: ');
        const phoneNumber = phoneInput || defaultPhone;
        if (!phoneNumber) {
            throw new Error('手机号为空');
        }

        await client.connect();
        console.log('正在请求 Telegram 验证码...');
        const sent = await client.invoke(new Api.auth.SendCode({
            phoneNumber,
            apiId: Number(tg.apiId),
            apiHash: tg.apiHash,
            settings: new Api.CodeSettings({})
        }));

        const phoneCode = await prompt.ask('请输入 Telegram 验证码: ');
        if (!phoneCode) {
            throw new Error('验证码为空');
        }

        try {
            await client.invoke(new Api.auth.SignIn({
                phoneNumber,
                phoneCodeHash: sent.phoneCodeHash,
                phoneCode
            }));
        } catch (error) {
            if (!isError(error, 'SESSION_PASSWORD_NEEDED')) {
                throw error;
            }
            const password = await prompt.ask('请输入 Telegram 2FA 密码: ');
            if (!password) {
                throw new Error('2FA 密码为空');
            }
            const passwordInfo = await client.invoke(new Api.account.GetPassword());
            await client.invoke(new Api.auth.CheckPassword({
                password: await computeCheck(passwordInfo, password)
            }));
        }

        config.telegramUser = {
            ...tg,
            phoneNumber,
            session: client.session.save(),
            enabled: true
        };
        writeConfig(config);
        console.log('');
        console.log('登录成功，session 已写入 config.json，telegramUser.enabled 已启用。');
        console.log('现在可以执行: docker compose restart tgbot-115');
    } finally {
        prompt.close();
        await client.disconnect().catch(() => {});
    }
}

main().catch(error => {
    console.error('');
    console.error('登录失败，Telegram 返回：');
    console.error(describeTelegramError(error));
    console.error('脚本已停止，没有继续重试验证码。');
    process.exit(1);
});
