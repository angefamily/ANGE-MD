const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.jpg');

async function sendConnectionConfirmation(sock) {
    const ownerJid = sock.user.id;
    if (!ownerJid) {
        throw new Error("Impossible d'envoyer la confirmation : identifiant du compte pas encore disponible.");
    }
    const text = [
        '👼 𝘼𝙉𝙂𝙀-𝗠𝗗 ✨',
        '━━━━━━━━━━━━━━━━━━━━',
        '',
        '╭━━━〔 👼 𝗔𝗡𝗚𝗘 𝗦𝗬𝗦𝗧𝗘𝗠 〕━━━╮',
        '┃',
        '┃  🟢 CONNEXION ÉTABLIE',
        '┃  ✨ Système opérationnel',
        '┃  👼 ANGE-MD est maintenant en ligne',
        '┃',
        '┃',
        '╰━━━━━━━━━━━━━━━━━━━━╯',
        '',
        '«✨ La lumière est activée. ANGE-MD veille désormais sur votre connexion.»',
        '',
        '🎯 Commande principale',
        '╰➤ Tape .menu pour accéder au royaume des commandes.',
        '',
        '━━━━━━━━━━━━━━━━━━━━',
        '👑 𝗞𝗜𝗡𝗚 𝗚𝗘𝗡𝗘𝗥𝗔𝗧𝗢𝗥 — 𝗜𝗔',
        '╰➤ https://king-generator-ai.lovable.app',
        '',
        '📢 𝗖𝗛𝗔𝗜̂𝗡𝗘 𝗪𝗛𝗔𝗧𝗦𝗔𝗣𝗣 𝗢𝗙𝗙𝗜𝗖𝗜𝗘𝗟𝗟𝗘',
        '╰➤ https://whatsapp.com/channel/0029VbCY0ob7YSd0Oc9d650O',
        '',
        '━━━━━━━━━━━━━━━━━━━━',
        '✨ 𝘼𝙉𝙂𝙀-𝗠𝗗 • 𝗚𝗨𝗜𝗗𝗘𝗗 𝗕𝗬 𝗟𝗜𝗚𝗛𝗧 👼',
    ].join('\n');

    try {
        if (fs.existsSync(LOGO_PATH)) {
            await sock.sendMessage(ownerJid, { image: fs.readFileSync(LOGO_PATH), caption: text });
        } else {
            await sock.sendMessage(ownerJid, { text });
        }
    } catch (e) {
        console.error('Erreur message de confirmation:', e.message);
    }
}

module.exports = { sendConnectionConfirmation };