const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');

function ensureLogDir() {
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
}

function appendLog(fileName, payload) {
    ensureLogDir();
    const line = `${JSON.stringify({
        ts: new Date().toISOString(),
        ...payload
    })}\n`;
    fs.appendFileSync(path.join(logDir, fileName), line, 'utf8');
}

function logRecognitionDiff(payload) {
    appendLog('recognition-diff.log', payload);
}

function logMergeSkip(payload) {
    appendLog('merge-skip.log', payload);
}

module.exports = {
    logRecognitionDiff,
    logMergeSkip
};
