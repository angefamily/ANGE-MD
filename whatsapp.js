const path = require('path');
const fs = require('fs');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const { sendConnectionConfirmation } = require('./lib/connectionMessage');
const { restoreSession } = require('./lib/sessionString');
const { getSettings } = require('./lib/botSettings');
const { getGroup, isToggled } = require('./lib/groupSettings');
const { loadCommands, handleMessage } = require('./messageHandler');

const SESSION_NUMBER = process.env.SESSION_NUMBER || 'default';
const SESSION_PATH = path.join(__dirname, 'session', SESSION_NUMBER);

let sock = null;
let latestQR = null;
// disconnected | connecting | qr | connected
let connectionStatus = 'disconnected';

function getState() {
    return { status: connectionStatus, qr: latestQR };
}

async function requestPairingCode(number) {
    if (!sock) throw new Error("Le bot n'est pas encore prêt, réessaie dans quelques secondes.");
    const digits = number.replace(/[^0-9]/g, '');
    if (!digits) throw new Error('Numéro invalide.');
    return sock.requestPairingCode(digits);
}

async function startSock() {
    if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

    // Restaure la session depuis SESSION_ID (utile après un redémarrage sur Render)
    if (process.env.SESSION_ID && !fs.existsSync(path.join(SESSION_PATH, 'creds.json'))) {
        restoreSession(SESSION_PATH, process.env.SESSION_ID);
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    connectionStatus = 'connecting';

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['ANGE-MD', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            connectionStatus = 'qr';
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            latestQR = null;
            loadCommands();
            await sendConnectionConfirmation(sock);
            console.log('✅ ANGE-MD est connecté à WhatsApp — guidé par la lumière.');
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(
                '🔌 Connexion fermée.',
                statusCode,
                shouldReconnect ? '— reconnexion...' : '— déconnecté définitivement.'
            );

            if (shouldReconnect) {
                setTimeout(() => {
                    startSock().catch((e) => console.error('❌ Erreur de reconnexion:', e.message));
                }, 3000);
            } else if (fs.existsSync(SESSION_PATH)) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;
            try {
                await applyAutoBehaviors(sock, m);
                await handleMessage(sock, m);
            } catch (e) {
                console.error('❌ Erreur messages.upsert:', e.message);
            }
        }
    });

    sock.ev.on('group-participants.update', async (event) => {
        try {
            await handleGroupParticipantsUpdate(sock, event);
        } catch (e) {
            console.error('❌ Erreur group-participants.update:', e.message);
        }
    });

    sock.ev.on('call', async (calls) => {
        const settings = getSettings();
        if (!settings.anticall) return;
        for (const call of calls) {
            try {
                await sock.rejectCall(call.id, call.from);
                if (settings.anticallMessage) {
                    await sock.sendMessage(call.from, { text: settings.anticallMessage });
                }
            } catch (e) {
                console.error('❌ Erreur anticall:', e.message);
            }
        }
    });

    return sock;
}

async function applyAutoBehaviors(sock, m) {
    const settings = getSettings();
    const from = m.key.remoteJid;

    if (settings.autoread) {
        try { await sock.readMessages([m.key]); } catch (_) {}
    }
    if (settings.autotyping) {
        try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}
    }
    if (settings.recording) {
        try { await sock.sendPresenceUpdate('recording', from); } catch (_) {}
    }
    if (from?.endsWith('@g.us') && isToggled(from, 'autoreact')) {
        try {
            await sock.sendMessage(from, { react: { text: '✨', key: m.key } });
        } catch (_) {}
    }
}

async function handleGroupParticipantsUpdate(sock, event) {
    const { id: groupJid, participants, action } = event;
    const group = getGroup(groupJid);

    if (action === 'add' && group.toggles?.welcome) {
        const template = group.welcomeMessage || '✨ Bienvenue @user dans le royaume céleste ! 👼';
        for (const p of participants) {
            const text = template.replace(/@user/g, `@${p.split('@')[0]}`);
            await sock.sendMessage(groupJid, { text, mentions: [p] });
        }
    }

    if (action === 'remove' && group.toggles?.goodbye) {
        const template = group.goodbyeMessage || '👋 @user a quitté le royaume céleste.';
        for (const p of participants) {
            const text = template.replace(/@user/g, `@${p.split('@')[0]}`);
            await sock.sendMessage(groupJid, { text, mentions: [p] });
        }
    }
}

module.exports = { startSock, getState, requestPairingCode };
