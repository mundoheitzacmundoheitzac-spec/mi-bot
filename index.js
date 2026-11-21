const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const Jimp = require('jimp');
const axios = require('axios');
const express = require('express');
const pino = require('pino');

let PREFIX = '/';
const OWNER_NUMBER = '5216391366054@s.whatsapp.net';
const BOT_NUMBER = '5216391366054';
const GEMINI_API_KEY = 'TU_API_KEY_DE_GEMINI';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const app = express();
app.get('/', (req, res) => res.send('Bot Activo 24/7'));
app.listen(3000, () => console.log('Servidor listo en puerto 3000'));

let botActivo = true;
const configGrupos = {};
const autoResponders = {};

function getGroupConfig(jid) {
    if (!configGrupos[jid]) {
        configGrupos[jid] = {
            antiLink: false, antiSticker: false, antiVideo: false,
            antiImage: false, antiAudio: false, welcome: false,
            onlyAdmin: false, autoSticker: false, warns: {}
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

            if (cfg.autoSticker && msgType === 'imageMessage' && !body.startsWith(PREFIX)) {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const sticker = new Sticker(buffer, { pack: 'AutoSticker', author: 'Bot', type: StickerTypes.FULL });
                return sock.sendMessage(from, await sticker.toMessage());
            }
        }

        const lowerBody = body.toLowerCase().trim();
        if (autoResponders[lowerBody]) {
            return sock.sendMessage(from, { text: autoResponders[lowerBody] }, { quoted: msg });
        }

        if (!body.startsWith(PREFIX)) return;

        const args = body.slice(PREFIX.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(' ');

        if (command === 'off' || command === 'on' || command === 'set-prefix' || command === 'get-group-id') {
            if (!isOwner) return sock.sendMessage(from, { text: '👑 Exclusivo dueño.' });
            if (command === 'off') { botActivo = false; return sock.sendMessage(from, { text: '🔴 Bot apagado.' }); }
            if (command === 'on') { botActivo = true; return sock.sendMessage(from, { text: '🟢 Bot encendido.' }); }
            if (command === 'set-prefix' && text) { PREFIX = text.at(0); return sock.sendMessage(from, { text: `✅ Nuevo prefijo: *${PREFIX}*` }); }
            if (command === 'get-group-id') return sock.sendMessage(from, { text: `🆔 ID: ${from}` });
        }

        if (!botActivo) return;
        if (isGroup && getGroupConfig(from).onlyAdmin && !isAdmin && !isOwner) return;

        const comandosAdmin = [
            'hidetag', 'link-group', 'set-name', 'delete', 'open', 'close',
            'ban', 'promote', 'demote', 'welcome', 'anti-link', 'anti-sticker',
            'anti-image', 'anti-video', 'anti-audio', 'only-admin', 'auto-sticker',
            'warn', 'unwarn', 'add-auto-responder', 'delete-auto-responder'
        ];

        if (comandosAdmin.includes(command)) {
            if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Solo en grupos.' });
            if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '🛡️ Solo los administradores pueden usar este comando.' });
        }

        const mencionado = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.at(0);
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        switch (command) {
            case 'menu':
                const menuText = `🤖 *MENÚ DEL BOT*\n\n` +
                    `👑 *DUEÑO*\n• /on | /off | /set-prefix | /get-group-id\n\n` +
                    `🛡️ *ADMINS*\n• /ban | /promote | /demote | /hidetag\n• /link-group | /open | /close | /set-name\n• /delete | /welcome 1/0 | /only-admin 1/0\n• /auto-sticker 1/0 | /anti-link 1/0\n• /anti-sticker 1/0 | /anti-image 1/0\n• /anti-video 1/0 | /anti-audio 1/0\n• /warn | /unwarn | /add-auto-responder\n\n` +
                    `🚀 *PRINCIPAL*\n• /sticker | /to-image | /ping\n• /generate-link | /profile | /reveal\n\n` +
                    `🎵 *DESCARGAS*\n• /play-audio | /yt-mp3 | /tik-tok\n\n` +
                    `🎡 *DIVERSIÓN*\n• /abrazar | /besar | /bofetada | /cenar\n• /dado | /golpear | /luchar | /matar\n\n` +
                    `🧠 *IA & EDICIÓN*\n• /gemini | /flux | /ia-sticker\n• /blur | /contraste | /gray | /invert | /mirror | /pixel`;
                await sock.sendMessage(from, { text: menuText });
                break;

