// Téléchargement de médias — adapté pour whatsapp-web.js (m._raw est le
// message original de la librairie, qui expose directement .downloadMedia()).

async function getMediaMessage(m) {
    const raw = m._raw;
    if (!raw) return null;

    let target = raw;
    if (raw.hasQuotedMsg) {
        try {
            const quoted = await raw.getQuotedMessage();
            if (quoted?.hasMedia) target = quoted;
        } catch (_) {
            // pas de message cité exploitable, on retombe sur le message lui-même
        }
    }

    if (!target.hasMedia) return null;

    const typeMap = { image: 'image', video: 'video', sticker: 'sticker', ptt: 'audio', audio: 'audio', document: 'document' };
    return { message: target, type: typeMap[target.type] || target.type };
}

async function bufferFromMessage(rawMessage) {
    const media = await rawMessage.downloadMedia();
    if (!media?.data) throw new Error('Impossible de télécharger le média.');
    return Buffer.from(media.data, 'base64');
}

module.exports = { bufferFromMessage, getMediaMessage };
