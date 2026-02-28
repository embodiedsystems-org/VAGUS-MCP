/**
 * Read/write session token to ~/.openclaw/vagus-session.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_PATH = path.join(os.homedir(), '.openclaw', 'vagus-session.json');

class SessionStore {
  load() {
    try {
      const raw = fs.readFileSync(SESSION_PATH, 'utf-8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  save(data) {
    const dir = path.dirname(SESSION_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_PATH, JSON.stringify(data, null, 2));
  }

  delete() {
    try { fs.unlinkSync(SESSION_PATH); } catch (_) {}
  }

  exists() {
    return fs.existsSync(SESSION_PATH);
  }
}

module.exports = { SessionStore };
