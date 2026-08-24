const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const { handleMessage } = require('./messageHandler');
const { getGroup, isToggled } = require('./lib/groupSettings');
const { getSettings } = require('./lib/botSettings');
const { sendConnectionConfirmation } = require('./lib/connectionMessage');

const SESSION_PATH = path.join(__dirname, 'session');
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

let client = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | qr | connected
let latestQR = null;
let initInProgress = false;

function setStatus(s) {
    connectionStatus = s;
}

function getStatus() {
    return connectionStatus;
}

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
];

const PUPPETEER_CONFIG = {
    headless: true,
    args: PUPPETEER_ARGS,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
};

// ---------------------------------------------------------------
// Adaptateur : traduit les objets whatsapp-web.js vers le même
// format que celui utilisé par messageHandler.js et les commandes
// (héritage de l'architecture Baileys : sock.sendMessage, m.key...)
// ---------------------------------------------------------------
function wrapMessage(msg) {
    const isGroup = msg.from.endsWith('@g.us');
    return {
        key: {
            remoteJid: msg.from,
            participant: isGroup ? msg.author : undefined,
            fromMe: msg.fromMe,
            id: msg.id?._serialized,
        },
        message: {
            conversation: msg.body || '',
            extendedTextMessage: msg.hasQuotedMsg ? { text: msg.body || '', contextInfo: { stanzaId: msg.id?._serialized } } : undefined,
        },
        _raw: msg,
    };
}

function buildSock(clientInstance) {
    return {
        _client: clientInstance,

        async sendMessage(jid, content = {}, options = {}) {
            const sendOpts = {};
            if (options.quoted?.key?.id) sendOpts.quotedMessageId = options.quoted.key.id;
            if (content.mentions) sendOpts.mentions = content.mentions;

            if (content.image) {
                const media = new MessageMedia('image/jpeg', Buffer.from(content.image).toString('base64'));
                return clientInstance.sendMessage(jid, media, { ...sendOpts, caption: content.caption });
            }
            if (content.video) {
                const media = new MessageMedia('video/mp4', Buffer.from(content.video).toString('base64'));
                return clientInstance.sendMessage(jid, media, { ...sendOpts, caption: content.caption });
            }
            if (content.sticker) {
                const media = new MessageMedia('image/webp', Buffer.from(content.sticker).toString('base64'));
                return clientInstance.sendMessage(jid, media, { ...sendOpts, sendMediaAsSticker: true });
            }
            if (content.react) {
                try {
                    const target = await clientInstance.getMessageById(content.react.key.id);
                    if (target) return target.react(content.react.text);
                } catch (_) {}
                return;
            }
            return clientInstance.sendMessage(jid, content.text || '', sendOpts);
        },

        async groupMetadata(jid) {
            const chat = await clientInstance.getChatById(jid);
            return {
                subject: chat.name,
                desc: chat.description,
                participants: (chat.participants || []).map((p) => ({
                    id: p.id._serialized,
                    admin: p.isSuperAdmin ? 'superadmin' : p.isAdmin ? 'admin' : null,
                })),
            };
        },

        async groupParticipantsUpdate(jid, participants, action) {
            const chat = await clientInstance.getChatById(jid);
            if (action === 'remove') return chat.removeParticipants(participants);
            if (action === 'add') return chat.addParticipants(participants);
            if (action === 'promote') return chat.promoteParticipants(participants);
            if (action === 'demote') return chat.demoteParticipants(participants);
        },

        async groupCreate(name, participants) {
            return clientInstance.createGroup(name, participants);
        },
        async groupLeave(jid) {
            const chat = await clientInstance.getChatById(jid);
            return chat.leave();
        },
        async groupInviteCode(jid) {
            const chat = await clientInstance.getChatById(jid);
            return chat.getInviteCode();
        },
        async groupRevokeInvite(jid) {
            const chat = await clientInstance.getChatById(jid);
            return chat.revokeInvite();
        },
        async groupAcceptInvite(code) {
            return clientInstance.acceptInvite(code);
        },
        async groupUpdateSubject(jid, subject) {
            const chat = await clientInstance.getChatById(jid);
            return chat.setSubject(subject);
        },
        async groupUpdateDescription(jid, desc) {
            const chat = await clientInstance.getChatById(jid);
            return chat.setDescription(desc);
        },
        async groupSettingUpdate(jid, setting) {
            const chat = await clientInstance.getChatById(jid);
            if (setting === 'announcement') return chat.setMessagesAdminsOnly(true);
            if (setting === 'not_announcement') return chat.setMessagesAdminsOnly(false);
            if (setting === 'locked') return chat.setInfoAdminsOnly && chat.setInfoAdminsOnly(true);
            if (setting === 'unlocked') return chat.setInfoAdminsOnly && chat.setInfoAdminsOnly(false);
        },
        // ⚠️ Non fiable / non garanti sur whatsapp-web.js (API communautaire limitée) :
        async groupRequestParticipantsList() { return []; },
        async groupRequestParticipantsUpdate() { return null; },
        async newsletterFollow() { throw new Error('Non supporté sur whatsapp-web.js pour le moment.'); },
        async newsletterMetadata() { throw new Error('Non supporté sur whatsapp-web.js pour le moment.'); },
        async newsletterReactMessage() { throw new Error('Non supporté sur whatsapp-web.js pour le moment.'); },

        async profilePictureUrl(jid) {
            try { return await clientInstance.getProfilePicUrl(jid); } catch (_) { return null; }
        },
        async updateProfileName(name) {
            if (typeof clientInstance.setDisplayName === 'function') return clientInstance.setDisplayName(name);
            throw new Error("setDisplayName n'est pas disponible sur cette version de whatsapp-web.js.");
        },
        async updateProfilePicture(jid, media) {
            const m = new MessageMedia('image/jpeg', Buffer.from(media).toString('base64'));
            return clientInstance.setProfilePicture(m);
        },
        async rejectCall() {
            // Les appels sont interceptés via l'event 'call' plus bas, pas via un appel direct ici.
        },
        async readMessages() {},
        async sendPresenceUpdate() {},

        get user() {
            return { id: clientInstance.info?.wid?._serialized };
        },
    };
}

function wireEvents(clientInstance, sock) {
    clientInstance.on('message', async (msg) => {
        try {
            if (msg.from === 'status@broadcast') return;
            const m = wrapMessage(msg);
            await applyAutoBehaviors(sock, m);
            await handleMessage(sock, m);
        } catch (e) {
            console.error('❌ Erreur message:', e.message);
        }
    });

    clientInstance.on('group_join', async (notification) => {
        try {
            const group = getGroup(notification.chatId);
            if (!group.toggles?.welcome) return;
            const template = group.welcomeMessage || '✨ Bienvenue @user dans le royaume céleste ! 👼';
            for (const p of notification.recipientIds || []) {
                const text = template.replace(/@user/g, `@${p.split('@')[0]}`);
                await sock.sendMessage(notification.chatId, { text, mentions: [p] });
            }
        } catch (e) {
            console.error('❌ Erreur welcome:', e.message);
        }
    });

    clientInstance.on('group_leave', async (notification) => {
        try {
            const group = getGroup(notification.chatId);
            if (!group.toggles?.goodbye) return;
            const template = group.goodbyeMessage || '👋 @user a quitté le royaume céleste.';
            for (const p of notification.recipientIds || []) {
                const text = template.replace(/@user/g, `@${p.split('@')[0]}`);
                await sock.sendMessage(notification.chatId, { text, mentions: [p] });
            }
        } catch (e) {
            console.error('❌ Erreur goodbye:', e.message);
        }
    });

    clientInstance.on('call', async (call) => {
        try {
            const settings = getSettings();
            if (settings.anticall) await call.reject();
        } catch (e) {
            console.error('❌ Erreur anticall:', e.message);
        }
    });

    clientInstance.on('disconnected', (reason) => {
        console.warn('❌ Déconnecté :', reason);
        setStatus('disconnected');
    });
}

async function applyAutoBehaviors(sock, m) {
    const settings = getSettings();
    const from = m.key.remoteJid;
    if (from?.endsWith('@g.us') && isToggled(from, 'autoreact')) {
        try {
            await sock.sendMessage(from, { react: { text: '✨', key: m.key } });
        } catch (_) {}
    }
}

// ---------------------------------------------------------------
// Connexion par pairing code (numéro de téléphone)
// ---------------------------------------------------------------
async function connectToWhatsApp(number) {
    if (initInProgress) {
        throw new Error('Une connexion est déjà en cours, patiente quelques secondes.');
    }
    const sanitizedNumber = (number || '').replace(/[^0-9]/g, '');
    if (sanitizedNumber.length < 8) {
        throw new Error(`Numéro invalide : "${number}" (n'oublie pas l'indicatif pays, sans le +)`);
    }

    if (client) {
        return null; // déjà initialisé / en cours
    }

    initInProgress = true;
    setStatus('connecting');

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                initInProgress = false;
                reject(new Error("Délai dépassé pour l'obtention du code, réessaie."));
            }
        }, 45000);

        client = new Client({
            authStrategy: new LocalAuth({ clientId: 'ange-md', dataPath: SESSION_PATH }),
            puppeteer: PUPPETEER_CONFIG,
            pairWithPhoneNumber: { phoneNumber: sanitizedNumber, showNotification: true },
        });

        const sock = buildSock(client);
        wireEvents(client, sock);

        client.on('code', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                initInProgress = false;
                resolve(code);
            }
        });

        client.on('ready', async () => {
            console.log('✅ ANGE-MD connecté à WhatsApp (pairing code) !');
            setStatus('connected');
            await sendConnectionConfirmation(sock).catch((e) => console.error(e.message));
        });

        client.initialize().catch((e) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                initInProgress = false;
                client = null;
                reject(e);
            }
        });
    });
}

// ---------------------------------------------------------------
// Connexion par QR code
// ---------------------------------------------------------------
async function connectViaQR() {
    if (initInProgress) {
        throw new Error('Une connexion est déjà en cours, patiente quelques secondes.');
    }
    if (client) {
        return null;
    }

    initInProgress = true;
    setStatus('connecting');

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                initInProgress = false;
                reject(new Error('Délai dépassé pour la génération du QR, réessaie.'));
            }
        }, 45000);

        client = new Client({
            authStrategy: new LocalAuth({ clientId: 'ange-md', dataPath: SESSION_PATH }),
            puppeteer: PUPPETEER_CONFIG,
        });

        const sock = buildSock(client);
        wireEvents(client, sock);

        client.on('qr', (qr) => {
            latestQR = qr;
            setStatus('qr');
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                initInProgress = false;
                resolve(qr);
            }
        });

        client.on('ready', async () => {
            console.log('✅ ANGE-MD connecté à WhatsApp (QR code) !');
            setStatus('connected');
            latestQR = null;
            await sendConnectionConfirmation(sock).catch((e) => console.error(e.message));
        });

        client.initialize().catch((e) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                initInProgress = false;
                client = null;
                reject(e);
            }
        });
    });
}

// ---------------------------------------------------------------
// Reprise automatique d'une session déjà authentifiée (après redéploiement)
// ---------------------------------------------------------------
function hasExistingSession() {
    try {
        const sessionDir = path.join(SESSION_PATH, 'session-ange-md');
        return fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
    } catch (_) {
        return false;
    }
}

async function resumeIfSessionExists() {
    if (client || !hasExistingSession()) return;

    initInProgress = true;
    setStatus('connecting');

    client = new Client({
        authStrategy: new LocalAuth({ clientId: 'ange-md', dataPath: SESSION_PATH }),
        puppeteer: PUPPETEER_CONFIG,
    });

    const sock = buildSock(client);
    wireEvents(client, sock);

    client.on('ready', async () => {
        console.log('✅ ANGE-MD reconnecté automatiquement (session existante) !');
        setStatus('connected');
        initInProgress = false;
        await sendConnectionConfirmation(sock).catch((e) => console.error(e.message));
    });

    client.on('qr', () => {
        // Une session sauvegardée qui redemande un QR = session invalide/expirée côté WhatsApp
        console.warn('⚠️ Session existante invalide, un nouveau pairing est nécessaire.');
        setStatus('disconnected');
        initInProgress = false;
    });

    try {
        await client.initialize();
    } catch (e) {
        console.error('❌ Erreur de reprise de session:', e.message);
        client = null;
        initInProgress = false;
        setStatus('disconnected');
    }
}

module.exports = { connectToWhatsApp, connectViaQR, getStatus, resumeIfSessionExists };
