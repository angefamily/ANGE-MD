require('dotenv').config();
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

const { installErrorGuard } = require('./lib/errorGuard');
const { startCleanupLoop } = require('./lib/cleanup');
const { startSock, getState, requestPairingCode } = require('./whatsapp');
const { getConfig } = require('./lib/config');
const { getSettings } = require('./lib/botSettings');
const { commands } = require('./messageHandler');

installErrorGuard();

const app = express();
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// ---- Pages ----
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'Pair.html'));
});

app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'Qr.html'));
});

// ---- API : statut de connexion ----
app.get('/api/status', (req, res) => {
    const { status } = getState();
    res.json({ status });
});

// ---- API : QR code courant (image en data URL) ----
app.get('/api/qr', async (req, res) => {
    const { status, qr } = getState();
    if (status !== 'qr' || !qr) {
        return res.json({ status, qrDataUrl: null });
    }
    try {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        res.json({ status, qrDataUrl });
    } catch (e) {
        res.status(500).json({ error: 'Impossible de générer le QR code.' });
    }
});

// ---- API : demande d'un code de jumelage (pairing code) ----
app.post('/api/pair', async (req, res) => {
    const { number } = req.body || {};
    if (!number) {
        return res.status(400).json({ error: 'Numéro requis (indicatif pays, sans le +).' });
    }
    try {
        const code = await requestPairingCode(number);
        res.json({ code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- API : informations pour la page d'accueil (liens, nom, stats) ----
app.get('/api/site-info', (req, res) => {
    const cfg = getConfig();
    const settings = getSettings();
    const commandCount = new Set([...commands.values()].map((c) => c.name)).size;
    res.json({
        botName: settings.botName,
        ownerName: settings.ownerName,
        mode: settings.mode,
        prefix: cfg.prefix || '.',
        commandCount,
        channelLink: cfg.channelLink || null,
        groupInviteLink: cfg.groupInviteLink || null,
        angeGeneratorLink: 'https://neon-king-forge.lovable.app/',
    });
});

// ---- Santé (utile pour Render) ----
app.get('/health', (req, res) => res.send('👼 ANGE-MD est en ligne.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✨ Serveur ANGE-MD démarré sur le port ${PORT}`);
});

startCleanupLoop();
startSock().catch((e) => {
    console.error('❌ Erreur au démarrage de la connexion WhatsApp:', e.message);
});
