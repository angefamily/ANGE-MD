const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers,
    delay,
} = require('@whiskeysockets/baileys');

const { handleMessage } = require('./messageHandler');
const { isToggled } = require('./lib/groupSettings');
const { encodeSession, restoreSession } = require('./lib/sessionString');
const { sendConnectionConfirmation } = require('./lib/connectionMessage');

const SESSION_BASE_PATH = path.join(__dirname, 'session');
if (!fs.existsSync(SESSION_BASE_PATH)) fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });

let pairingInProgress = false;
let qrInProgress = false;

function wireCommonEvents(sock) {
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m?.message) return;

        if (m.key.remoteJid?.endsWith('@newsletter') && m.newsletterServerId) {
            const { setConfig } = require('./lib/config');
            setConfig({ lastNewsletterMessageId: String(m.newsletterServerId), lastNewsletterJid: m.key.remoteJid });
        }

        try {
            await handleMessage(sock, m);
        } catch (err) {
            console.error('Erreur handleMessage:', err.message);
        }
    });

    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        try {
            const { getGroup } = require('./lib/groupSettings');
            const g = getGroup(id);
            if (action === 'add' && isToggled(id, 'welcome')) {
                for (const jid of participants) {
                    const template = g.welcomeMessage || 'Bienvenue @user dans le groupe !';
                    await sock.sendMessage(id, {
                        text: `👋 ${template.replace('@user', `@${jid.split('@')[0]}`)}`,
                        mentions: [jid],
                    });
                }
            }
            if (action === 'remove' && isToggled(id, 'goodbye')) {
                for (const jid of participants) {
                    const template = g.goodbyeMessage || '@user a quitté le groupe.';
                    await sock.sendMessage(id, {
                        text: `👋 ${template.replace('@user', `@${jid.split('@')[0]}`)}`,
                        mentions: [jid],
                    });
                }
            }
        } catch (err) {
            console.error('Erreur welcome/goodbye:', err.message);
        }
    });

    sock.ev.on('call', async (calls) => {
        const { getSettings } = require('./lib/botSettings');
        const s = getSettings();
        if (!s.anticall) return;
        for (const call of calls) {
            try {
                await sock.rejectCall(call.id, call.from);
                await sock.sendMessage(call.from, { text: s.anticallMessage });
            } catch (err) {
                console.error('Erreur anticall:', err.message);
            }
        }
    });
}

function followOwnerChannel(sock) {
    const { getConfig } = require('./lib/config');
    const newsletterJid = getConfig().newsletterJid;
    if (newsletterJid) {
        sock.newsletterFollow(newsletterJid)
            .then(() => console.log(`📢 Abonné automatiquement au canal ${newsletterJid}`))
            .catch((e) => console.error('Erreur abonnement canal:', e.message));
    }
}

async function connectToWhatsApp(number) {
    if (pairingInProgress) {
        throw new Error('Une connexion est déjà en cours, patiente quelques secondes.');
    }

    const sanitizedNumber = (number || '').replace(/[^0-9]/g, '');
    if (sanitizedNumber.length < 8) {
        throw new Error(`Numéro invalide : "${number}" (n'oublie pas l'indicatif pays, sans le +)`);
    }

    pairingInProgress = true;

    try {
        const sessionPath = path.join(SESSION_BASE_PATH, sanitizedNumber);
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

        const credsExist = fs.existsSync(path.join(sessionPath, 'creds.json'));
        if (!credsExist && process.env.SESSION_ID && process.env.SESSION_NUMBER === sanitizedNumber) {
            const restored = restoreSession(sessionPath, process.env.SESSION_ID);
            if (restored) console.log(`♻️ Session restaurée depuis SESSION_ID pour ${sanitizedNumber}`);
        }

        const preCheck = await useMultiFileAuthState(sessionPath);
        if (!preCheck.state.creds?.registered) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📶 Baileys / WA version : ${version.join('.')}`);

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log('✅ Connecté à WhatsApp (pairing code) !');
                pairingInProgress = false;
                followOwnerChannel(sock);
                sendConnectionConfirmation(sock);
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.warn(`❌ Connexion fermée (code ${statusCode})`);
                pairingInProgress = false;
                if (statusCode !== 401 && state.creds?.registered) {
                    setTimeout(() => connectToWhatsApp(sanitizedNumber).catch(console.error), 3000);
                }
            }
        });

        wireCommonEvents(sock);

        if (!state.creds?.registered) {
            await delay(1500);
            const code = await sock.requestPairingCode(sanitizedNumber);
            pairingInProgress = false;
            return code?.match(/.{1,4}/g)?.join('-') || code;
        }

        pairingInProgress = false;
        return null;
    } catch (error) {
        pairingInProgress = false;
        throw error;
    }
}

async function connectViaQR() {
    if (qrInProgress) {
        throw new Error('Une génération de QR est déjà en cours, patiente quelques secondes.');
    }
    qrInProgress = true;

    try {
        const sessionPath = path.join(SESSION_BASE_PATH, '_qrsession');
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        fs.mkdirSync(sessionPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        return new Promise((resolve, reject) => {
            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
                },
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: Browsers.ubuntu('Chrome'),
            });

            sock.ev.on('creds.update', saveCreds);
            wireCommonEvents(sock);

            const timeout = setTimeout(() => {
                qrInProgress = false;
                reject(new Error('Délai dépassé, aucun QR reçu.'));
            }, 25000);

            sock.ev.on('connection.update', (update) => {
                if (update.qr) {
                    clearTimeout(timeout);
                    qrInProgress = false;
                    resolve(update.qr);
                }
                if (update.connection === 'open') {
                    console.log('✅ Connecté à WhatsApp (QR code) !');
                    followOwnerChannel(sock);
                sendConnectionConfirmation(sock);
                }
                if (update.connection === 'close') {
                    qrInProgress = false;
                }
            });
        });
    } catch (error) {
        qrInProgress = false;
        throw error;
    }
}

module.exports = { connectToWhatsApp, connectViaQR };
