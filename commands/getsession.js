const { isOwner } = require('../lib/permissions');

module.exports = {
    name: 'getsession',
    description: 'Explique comment la session est conservée (disque persistant Render, plus de SESSION_ID)',
    async execute({ sock, m, from }) {
        const senderJid = m.key.participant || from;
        if (!isOwner(senderJid)) {
            return sock.sendMessage(from, { text: '⛔ Owner uniquement.' }, { quoted: m });
        }

        await sock.sendMessage(from, {
            text: [
                'ℹ️ Depuis le passage à whatsapp-web.js, la session ne se copie plus dans une variable SESSION_ID.',
                '',
                'Elle est sauvegardée automatiquement dans le dossier /app/session — assure-toi que le disque persistant Render (voir render.yaml) est bien monté sur ce chemin.',
                '',
                'Tant que ce disque existe, le bot se reconnecte tout seul au redémarrage sans repasser par .pair ou le QR code.',
            ].join('\n'),
        }, { quoted: m });
    },
};
