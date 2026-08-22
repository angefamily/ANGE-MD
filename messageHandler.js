const fs = require('fs');
const path = require('path');
const { getConfig } = require('./lib/config');
const { getSettings } = require('./lib/botSettings');
const { isOwner } = require('./lib/permissions');
const { t } = require('./lib/i18n');

// name/alias (minuscule) -> module de commande
const commands = new Map();

function loadCommands() {
    commands.clear();
    const dir = path.join(__dirname, 'commands');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

    for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
            delete require.cache[require.resolve(fullPath)];
            const cmd = require(fullPath);
            if (!cmd?.name || typeof cmd.execute !== 'function') continue;

            commands.set(cmd.name.toLowerCase(), cmd);
            for (const alias of cmd.aliases || []) {
                commands.set(alias.toLowerCase(), cmd);
            }
        } catch (e) {
            console.error(`⚠️ Erreur de chargement de la commande ${file}:`, e.message);
        }
    }

    const total = new Set([...commands.values()].map((c) => c.name)).size;
    console.log(`✨ ${total} commandes ANGE-MD chargées.`);
}

function extractText(message) {
    return (
        message?.conversation ||
        message?.extendedTextMessage?.text ||
        message?.imageMessage?.caption ||
        message?.videoMessage?.caption ||
        ''
    );
}

async function handleMessage(sock, m) {
    if (!m.message) return;
    const from = m.key.remoteJid;
    if (!from || from === 'status@broadcast') return;

    const text = extractText(m.message).trim();
    if (!text) return;

    const prefix = getConfig().prefix || '.';
    if (!text.startsWith(prefix)) return;

    const [rawName, ...args] = text.slice(prefix.length).trim().split(/\s+/);
    const name = rawName?.toLowerCase();
    if (!name) return;

    const command = commands.get(name);
    if (!command) return;

    const senderJid = m.key.participant || m.key.remoteJid;
    const settings = getSettings();

    // Mode privé : seul le owner peut utiliser les commandes
    if (settings.mode === 'private' && !isOwner(senderJid)) return;

    try {
        await command.execute({ sock, m, from, args });
    } catch (err) {
        console.error(`❌ Erreur dans la commande "${name}":`, err.message);
        try {
            await sock.sendMessage(from, { text: t('genericError') }, { quoted: m });
        } catch (_) {
            // on ignore : si même l'envoi de l'erreur échoue, inutile de re-planter
        }
    }
}

module.exports = { commands, loadCommands, handleMessage };
