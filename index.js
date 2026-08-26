require('dotenv').config();
const path = require('path');
const express = require('express');

const { installErrorGuard } = require('./lib/errorGuard');
const { startCleanupLoop } = require('./lib/cleanup');
const { connectToWhatsApp, getStatus, resumeIfSessionExists } = require('./whatsapp');
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

// ---- API : statut de connexion (léger, pas de socket créé) ----
app.get('/api/status', (req, res) => {
    res.json({ status: getStatus() });
});

// ---- API : demande un code de jumelage (pairing code) ----
app.post('/api/pair', async (req, res) => {
    const { number } = req.body || {};
    if (!number) {
        return res.status(400).json({ error: 'Numéro requis (indicatif pays, sans le +).' });
    }
    try {
        const code = await connectToWhatsApp(number);
        if (!code) {
            return res.json({ code: null, message: 'Session déjà active pour ce numéro.' });
        }
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
        angeGeneratorLink: 'https://king-generator-ai.lovable.app/',
    });
});

// ---- Santé (utile pour Render) ----
app.get('/health', (req, res) => res.send('👼 ANGE-MD est en ligne.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✨ Serveur ANGE-MD démarré sur le port ${PORT}`);
});

startCleanupLoop();

// Reprise automatique au démarrage si une session est déjà sauvegardée sur le disque
// (essentiel sur Render : évite de re-scanner/re-pairer à chaque redéploiement,
// à condition que le disque persistant soit bien monté sur /app/session — voir render.yaml)
resumeIfSessionExists().catch((e) => {
    console.error('❌ Erreur de reconnexion automatique:', e.message);
});