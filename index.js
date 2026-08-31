require('dotenv').config();
const path = require('path');
const express = require('express');

const { installErrorGuard } = require('./lib/errorGuard');
const { startCleanupLoop } = require('./lib/cleanup');
const { connectToWhatsApp, getStatus, resumeIfSessionExists, forceDisconnect } = require('./whatsapp');
const { getConfig } = require('./lib/config');
const { getSettings } = require('./lib/botSettings');
const { commands } = require('./messageHandler');

installErrorGuard();

const app = express();
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'Pair.html'));
});

app.get('/api/status', (req, res) => {
    res.json({ status: getStatus() });
});

app.post('/api/pair', async (req, res) => {
    const { number } = req.body || {};
    if (!number) {
        return res.status(400).json({ error: 'Numéro requis (indicatif pays, sans le +).' });
    }
    try {
        const code = await connectToWhatsApp(number);
        if (!code) {
            return res.json({ code: null, message: 'Une connexion est déjà en cours, réessaie dans quelques secondes.' });
        }
        res.json({ code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/disconnect', async (req, res) => {
    try {
        await forceDisconnect();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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
        angeGeneratorLink: 'https://king-generator-ai.lovable.app',
    });
});

app.get('/health', (req, res) => res.send('👼 ANGE-MD est en ligne.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✨ Serveur ANGE-MD démarré sur le port ${PORT}`);
});

startCleanupLoop();

resumeIfSessionExists().catch((e) => {
    console.error('❌ Erreur de reconnexion automatique:', e.message);
});