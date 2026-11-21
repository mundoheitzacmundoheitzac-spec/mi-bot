const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const Jimp = require('jimp');
const axios = require('axios');
const express = require('express');
const pino = require('pino');

// --- CONFIGURACIÓN PRINCIPAL ---
let PREFIX = '/';
const OWNER_NUMBER = '5216391366054@s.whatsapp.net';
const BOT_NUMBER = '5216391366054';
const GEMINI_API_KEY = 'TU_API_KEY_DE_GEMINI';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Servidor web 24/7
const app = express();
app.get('/', (req, res) => res.send('Bot Activo 24/7'));
app.listen(3000, () => console.log('Servidor listo en puerto 3000'));

// Memorias del bot
let botActivo = true;
const configGrupos = {};
const autoResponders = {};

function getGroupConfig(jid) {
    if (!configGrupos[jid]) {
        configGrupos[jid] = {
            antiLink: false,
            antiSticker: false,
            antiVideo: false,
            antiImage: false,
            antiAudio: false,
            welcome: false,
            onlyAdmin: false,
            autoSticker: false,
            warns: {}
        };
    }
    return configGrupos[jid];
}

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('sesion_bot');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            let code = await sock.requestPairingCode(BOT_NUMBER);
            console.log('====================================');
            console.log('TU CODIGO DE VINCULACION ES:', code);
            console.log('====================================');
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    // --- EVENTO DE BIENVENIDA (/welcome) ---
    sock.ev.on('group-participants.update', async (anu) => {
        const cfg = getGroupConfig(anu.id);
        if (!cfg.welcome) return;
        for (let num of anu.participants) {
            if (anu.action === 'add') {
                await sock.sendMessage(anu.id, {
                    text: `╭━━━⪩ *¡BIENVENIDO/A!* ⪨━━━\n┃ Hola @${num.split('@').at(0)}\n┃ Disfruta del grupo y respeta las reglas.\n╰━━━━━━━━━━━━━━`,
                    mentions: [num]
                });
            }
        }
    });

    // --- EVENTO DE MENSAJES ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages.at(0);
        if (!msg || !msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? msg.key.participant : from;
        const isOwner = sender === OWNER_NUMBER;
        const msgType = Object.keys(msg.message).at(0);
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';

        let groupMetadata, isAdmin = false;
        if (isGroup) {
            groupMetadata = await sock.groupMetadata(from);
            const admins = groupMetadata.participants.filter(p => p.admin !== null).map(p => p.id);
            isAdmin = admins.includes(sender);
            const cfg = getGroupConfig(from);

            // Filtros Anti-Spam en grupos (ignora a admins y dueño)
            if (!isAdmin && !isOwner) {
                if (cfg.antiLink && body.includes('://whatsapp.com')) {
                    await sock.sendMessage(from, { delete: msg.key });
                    return sock.groupParticipantsUpdate(from, [sender], 'remove');
                }
                if (cfg.antiSticker && msgType === 'stickerMessage') return sock.sendMessage(from, { delete: msg.key });
                if (cfg.antiVideo && msgType === 'videoMessage') return sock.sendMessage(from, { delete: msg.key });
                if (cfg.antiImage && msgType === 'imageMessage') return sock.sendMessage(from, { delete: msg.key });
                if (cfg.antiAudio && msgType === 'audioMessage') return sock.sendMessage(from, { delete: msg.key });
            }

            // Auto-Sticker
            if (cfg.autoSticker && msgType === 'imageMessage' && !body.startsWith(PREFIX)) {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const sticker = new Sticker(buffer, { pack: 'AutoSticker', author: 'Bot', type: StickerTypes.FULL });
                return sock.sendMessage(from, await sticker.toMessage());
            }
        }

        // Auto-Responder
        const lowerBody = body.toLowerCase().trim();
        if (autoResponders[lowerBody]) {
            return sock.sendMessage(from, { text: autoResponders[lowerBody] }, { quoted: msg });
        }

        if (!body.startsWith(PREFIX)) return;

        const args = body.slice(PREFIX.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(' ');

        // --- COMANDOS EXCLUSIVOS DE DUEÑO ---
        if (command === 'off' || command === 'on' || command === 'set-prefix' || command === 'get-group-id') {
            if (!isOwner) return sock.sendMessage(from, { text: '👑 Este comando es exclusivo para el dueño del bot.' });
            if (command === 'off') { botActivo = false; return sock.sendMessage(from, { text: '🔴 Bot apagado.' }); }
            if (command === 'on') { botActivo = true; return sock.sendMessage(from, { text: '🟢 Bot encendido.' }); }
            if (command === 'set-prefix' && text) { PREFIX = text.at(0); return sock.sendMessage(from, { text: `✅ Nuevo prefijo: *${PREFIX}*` }); }
            if (command === 'get-group-id') return sock.sendMessage(from, { text: `🆔 ID: ${from}` });
        }

        if (!botActivo) return;

        // Bloqueo Only-Admin
        if (isGroup && getGroupConfig(from).onlyAdmin && !isAdmin && !isOwner) return;

        // --- BLOQUEO ESTRICTO PARA COMANDOS DE ADMINS ---
        const comandosAdmin = [
            'hidetag', 'link-group', 'set-name', 'delete', 'open', 'close',
            'ban', 'promote', 'demote', 'welcome', 'anti-link', 'anti-sticker',
            'anti-image', 'anti-video', 'anti-audio', 'only-admin', 'auto-sticker',
            'warn', 'unwarn', 'add-auto-responder', 'delete-auto-responder'
        ];

        if (comandosAdmin.includes(command)) {
            if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Este comando solo funciona dentro de grupos.' });
            if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '🛡️ Acceso denegado: Solo los administradores del grupo pueden usar este comando.' });
        }

        const mencionado = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.at(0);
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        switch (command) {
            // ================= MENÚ =================
            case 'menu':
                const fecha = new Date().toLocaleDateString('es-MX');
                const hora = new Date().toLocaleTimeString('es-MX');
                const menuText = `🤖\n╭━━━⪩ *¡BIENVENIDO!* ⪨━━━\n┃\n┃ • *Fecha:* ${fecha}\n┃ • *Hora:* ${hora}\n┃ • *Prefijo:* ${PREFIX}\n┃\n╰━━━ 「 🪐 」 ━━━\n\n` +
                    `╭━━━⪩ *DUEÑO* ⪨━━━\n┃ • /on | /off\n┃ • /set-prefix\n┃ • /get-group-id\n╰━━━ 「 🏞️ 」 ━━━\n\n` +
                    `╭━━━⪩ *ADMINS* ⪨━━━\n┃ • /ban | /promote | /demote\n┃ • /hidetag | /link-group\n┃ • /open | /close | /set-name\n┃ • /delete (responde mensaje)\n┃ • /welcome (1/0)\n┃ • /only-admin (1/0)\n┃ • /auto-sticker (1/0)\n┃ • /anti-link (1/0)\n┃ • /anti-sticker (1/0)\n┃ • /anti-image (1/0)\n┃ • /anti-video (1/0)\n┃ • /anti-audio (1/0)\n┃ • /warn | /unwarn\n┃ • /add-auto-responder palabra|resp\n┃ • /delete-auto-responder palabra\n╰━━━ 「 ⭐ 」 ━━━\n\n` +
                    `╭━━━⪩ *PRINCIPAL* ⪨━━━\n┃ • /sticker | /to-image\n┃ • /ping | /generate-link\n┃ • /profile | /reveal\n╰━━━ 「 🚀 」 ━━━\n\n` +
                    `╭━━━⪩ *DESCARGAS* ⪨━━━\n┃ • /play-audio (canción)\n┃ • /yt-mp3 (link youtube)\n┃ • /tik-tok (link tiktok)\n╰━━━ 「 🎵 」 ━━━\n\n` +
                    `╭━━━⪩ *DIVERSIÓN* ⪨━━━\n┃ • /abrazar | /besar | /bofetada\n┃ • /cenar | /dado | /golpear\n┃ • /luchar | /matar\n╰━━━ 「 🎡 」 ━━━\n\n` +
                    `╭━━━⪩ *IA* ⪨━━━\n┃ • /gemini (pregunta)\n┃ • /flux (crear imagen)\n┃ • /ia-sticker (crear sticker)\n╰━━━ 「 🚀 」 ━━━\n\n` +
                    `╭━━━⪩ *EDICIÓN / CANVAS* ⪨━━━\n┃ • /blur | /contraste | /gray\n┃ • /invert | /mirror | /pixel\n╰━━━ 「 ❇️ 」 ━━━`;
                await sock.sendMessage(from, { text: menuText });
                break;

            // ================= ADMINS =================
            case 'hidetag':
                await sock.sendMessage(from, { text: text || '📢 Atención a todos', mentions: groupMetadata.participants.map(p => p.id) });
                break;

            case 'link-group':
                const invite = await sock.groupInviteCode(from);
                await sock.sendMessage(from, { text: `🔗 https://://whatsapp.com${invite}` });
                break;

            case 'set-name':
                if (!text) return sock.sendMessage(from, { text: '⚠️ Escribe el nuevo nombre del grupo.' });
                await sock.groupUpdateSubject(from, text);
                await sock.sendMessage(from, { text: '✅ Nombre del grupo actualizado.' });
                break;

            case 'delete':
                if (!quoted) return sock.sendMessage(from, { text: '⚠️ Responde al mensaje que quieres borrar.' });
                const stanzaId = msg.message.extendedTextMessage.contextInfo.stanzaId;
