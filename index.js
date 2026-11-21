const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const Jimp = require('jimp');
const axios = require('axios');
const express = require('express');
const pino = require('pino');

let PREFIX = '/';
const OWNER_NUMBER = '526391366054@s.whatsapp.net';
const BOT_NUMBER = '526391366054';
const GEMINI_API_KEY = 'TU_API_KEY_DE_GEMINI';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot Activo 24/7'));
app.listen(PORT, () => console.log('Servidor listo en puerto ' + PORT));

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
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'error' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop')

    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(BOT_NUMBER);
                console.log('====================================');
                console.log('TU CODIGO DE VINCULACION ES:', code);
                console.log('====================================');
            } catch (err) {
                console.log('Error al pedir codigo:', err);
            }
        }, 4000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') console.log('✅ ¡WHATSAPP CONECTADO CON EXITO!');
        if (connection === 'close') iniciarBot();
    });

    sock.ev.on('group-participants.update', async (anu) => {
        const cfg = getGroupConfig(anu.id);
        if (!cfg.welcome) return;
        for (let num of anu.participants) {
            if (anu.action === 'add') {
                await sock.sendMessage(anu.id, { text: `👋 ¡Bienvenido/a @${num.split('@').at(0)}!`, mentions: [num] });
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
            isAdmin = groupMetadata.participants.filter(p => p.admin !== null).map(p => p.id).includes(sender);
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
        if (autoResponders[lowerBody]) return sock.sendMessage(from, { text: autoResponders[lowerBody] }, { quoted: msg });
        if (!body.startsWith(PREFIX)) return;

        const args = body.slice(PREFIX.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(' ');

        if (['off', 'on', 'set-prefix', 'get-group-id'].includes(command)) {
            if (!isOwner) return sock.sendMessage(from, { text: '👑 Solo el dueño.' });
            if (command === 'off') { botActivo = false; return sock.sendMessage(from, { text: '🔴 Apagado.' }); }
            if (command === 'on') { botActivo = true; return sock.sendMessage(from, { text: '🟢 Encendido.' }); }
            if (command === 'set-prefix' && text) { PREFIX = text.at(0); return sock.sendMessage(from, { text: `✅ Prefijo: *${PREFIX}*` }); }
            if (command === 'get-group-id') return sock.sendMessage(from, { text: `🆔 ${from}` });
        }

        if (!botActivo) return;
        if (isGroup && getGroupConfig(from).onlyAdmin && !isAdmin && !isOwner) return;

        const comandosAdmin = ['hidetag', 'link-group', 'set-name', 'delete', 'open', 'close', 'ban', 'promote', 'demote', 'welcome', 'anti-link', 'anti-sticker', 'anti-image', 'anti-video', 'anti-audio', 'only-admin', 'auto-sticker', 'warn', 'unwarn', 'add-auto-responder', 'delete-auto-responder'];
        if (comandosAdmin.includes(command)) {
            if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Solo en grupos.' });
            if (!isAdmin && !isOwner) return sock.sendMessage(from, { text: '🛡️ Solo admins del grupo.' });
        }

        const mencionado = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.at(0);
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        switch (command) {
            case 'menu':
                await sock.sendMessage(from, { text: `🤖 *MENÚ COMPLETO*\n\n👑 *DUEÑO:* /on | /off | /set-prefix | /get-group-id\n\n🛡️ *ADMINS:* /ban | /promote | /demote | /hidetag | /link-group | /open | /close | /set-name | /delete | /welcome 1/0 | /only-admin 1/0 | /auto-sticker 1/0 | /anti-link 1/0 | /anti-sticker 1/0 | /anti-image 1/0 | /anti-video 1/0 | /anti-audio 1/0 | /warn | /unwarn | /add-auto-responder | /delete-auto-responder\n\n🚀 *PRINCIPAL:* /sticker | /to-image | /ping | /generate-link | /profile | /reveal\n\n🎵 *DESCARGAS:* /play-audio | /yt-mp3 | /tik-tok\n\n🎡 *DIVERSIÓN:* /abrazar | /besar | /bofetada | /cenar | /dado | /golpear | /luchar | /matar\n\n🧠 *IA & EDICIÓN:* /gemini | /flux | /ia-sticker | /blur | /contraste | /gray | /invert | /mirror | /pixel` });
                break;
            case 'hidetag':
                await sock.sendMessage(from, { text: text || '📢 Atención', mentions: groupMetadata.participants.map(p => p.id) });
                break;
            case 'link-group':
                await sock.sendMessage(from, { text: `🔗 https://whatsapp.com{await sock.groupInviteCode(from)}` });
                break;
            case 'set-name':
                if (text) { await sock.groupUpdateSubject(from, text); await sock.sendMessage(from, { text: '✅ Nombre cambiado.' }); }
                break;
            case 'delete':
                if (quoted) await sock.sendMessage(from, { delete: { remoteJid: from, fromMe: false, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant } });
                break;
            case 'open':
            case 'close':
                await sock.groupSettingUpdate(from, command === 'open' ? 'not_announcement' : 'announcement');
                await sock.sendMessage(from, { text: command === 'open' ? '🔓 Abierto.' : '🔒 Cerrado.' });
                break;
            case 'ban':
            case 'promote':
            case 'demote':
                if (mencionado) { await sock.groupParticipantsUpdate(from, [mencionado], command === 'ban' ? 'remove' : command); await sock.sendMessage(from, { text: '✅ Listo.' }); }
                break;
            case 'welcome': case 'anti-link': case 'anti-sticker': case 'anti-image': case 'anti-video': case 'anti-audio': case 'only-admin': case 'auto-sticker':
                if (text === '1' || text === '0') {
                    const mapKey = { 'welcome': 'welcome', 'anti-link': 'antiLink', 'anti-sticker': 'antiSticker', 'anti-image': 'antiImage', 'anti-video': 'antiVideo', 'anti-audio': 'antiAudio', 'only-admin': 'onlyAdmin', 'auto-sticker': 'autoSticker' };
                    getGroupConfig(from)[mapKey[command]] = text === '1';
                    await sock.sendMessage(from, { text: `⚙️ *${command}* ${text === '1' ? 'ON' : 'OFF'}` });
                }
                break;
            case 'warn':
                if (mencionado) {
                    const gCfg = getGroupConfig(from);
                    gCfg.warns[mencionado] = (gCfg.warns[mencionado] || 0) + 1;
                    if (gCfg.warns[mencionado] >= 3) { delete gCfg.warns[mencionado]; await sock.groupParticipantsUpdate(from, [mencionado], 'remove'); await sock.sendMessage(from, { text: '🚫 Expulsado por 3 advertencias.' }); }
                    else await sock.sendMessage(from, { text: `⚠️ Advertencia ${gCfg.warns[mencionado]}/3` });
                }
                break;
            case 'unwarn':
                if (mencionado) { getGroupConfig(from).warns[mencionado] = 0; await sock.sendMessage(from, { text: '✅ Advertencias en 0.' }); }
                break;
            case 'add-auto-responder':
                if (text.includes('|')) { const [t, r] = text.split('|'); autoResponders[t.trim().toLowerCase()] = r.trim(); await sock.sendMessage(from, { text: '✅ Guardado.' }); }
                break;
            case 'delete-auto-responder':
                if (text) { delete autoResponders[text.trim().toLowerCase()]; await sock.sendMessage(from, { text: '🗑️ Borrado.' }); }
                break;
            case 'ping':
                await sock.sendMessage(from, { text: '🏓 ¡Pong!' });
                break;
            case 'generate-link':
                await sock.sendMessage(from, { text: `🔗 https://wa.me{sender.split('@').at(0)}` });
                break;
            case 'profile':
                const targetProf = mencionado || sender;
                let ppUrl = 'https://ibb.co';
                try { ppUrl = await sock.profilePictureUrl(targetProf, 'image'); } catch (e) {}
                await sock.sendMessage(from, { image: { url: ppUrl }, caption: `👤 @${targetProf.split('@').at(0)}`, mentions: [targetProf] });
                break;
            case 'sticker':
                const imgMsg = msg.message.imageMessage || quoted?.imageMessage || msg.message.videoMessage || quoted?.videoMessage;
                if (imgMsg) { const st = new Sticker(await downloadMediaMessage({ message: quoted || msg.message }, 'buffer', {}), { pack: 'Bot', author: 'WA', type: StickerTypes.FULL }); await sock.sendMessage(from, await st.toMessage()); }
                break;
            case 'to-image':
                if (quoted?.stickerMessage) await sock.sendMessage(from, { image: await downloadMediaMessage({ message: quoted }, 'buffer', {}) });
                break;
            case 'reveal':
                const vo = quoted?.viewOnceMessageV2?.message || quoted?.viewOnceMessage?.message;
                if (vo) { const b = await downloadMediaMessage({ message: vo }, 'buffer', {}); if (vo.imageMessage) await sock.sendMessage(from, { image: b }); if (vo.videoMessage) await sock.sendMessage(from, { video: b }); }
                break;
            case 'play-audio': case 'yt-mp3':
                if (text) {
                    try {
                        await sock.sendMessage(from, { text: '⏳ Descargando...' });
                        let vUrl = text, tit = 'Audio';
                        if (!text.includes('youtu')) { const b = await yts(text); vUrl = b.videos.at(0).url; tit = b.videos.at(0).title; }
                        const stream = ytdl(vUrl, { filter: 'audioonly', quality: 'lowestaudio' });
                        const chunks = []; for await (const c of stream) chunks.push(c);
                        await sock.sendMessage(from, { audio: Buffer.concat(chunks), mimetype: 'audio/mp4', fileName: `${tit}.mp3` }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(from, { text: '❌ Error al descargar.' }); }
                }
                break;
            case 'tik-tok':
                if (text) { try { const r = await axios.get(`https://tikwm.com{encodeURIComponent(text)}`); if (r.data?.data?.play) await sock.sendMessage(from, { video: { url: r.data.data.play } }); } catch (e) {} }
                break;
            case 'dado':
                await sock.sendMessage(from, { text: `🎲 *${Math.floor(Math.random() * 6) + 1}*` });
                break;
            case 'abrazar': case 'besar': case 'bofetada': case 'cenar': case 'golpear': case 'luchar': case 'matar':
                if (mencionado) {
                    const v = { abrazar: 'abrazó a', besar: 'besó a', bofetada: 'abofeteó a', cenar: 'cenó con', golpear: 'golpeó a', luchar: 'luchó contra', matar: 'eliminó a' };
                    await sock.sendMessage(from, { text: `@${sender.split('@').at(0)} ${v[command]} @${mencionado.split('@').at(0)}`, mentions: [sender, mencionado] });
                }
                break;
            case 'gemini':
                if (text) { try { const m = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }); const res = await m.generateContent(text); await sock.sendMessage(from, { text: res.response.text() }); } catch (e) { await sock.sendMessage(from, { text: '❌ Falta API Key.' }); } }
                break;
            case 'flux':
                if (text) await sock.sendMessage(from, { image: { url: `https://pollinations.ai{encodeURIComponent(text)}?nologo=true` } });
                break;
            case 'ia-sticker':
                if (text) { const aiSt = new Sticker(`https://pollinations.ai{encodeURIComponent(text)}?width=512&height=512&nologo=true`, { pack: 'IA', author: 'Bot', type: StickerTypes.FULL }); await sock.sendMessage(from, await aiSt.toMessage()); }
                break;
            case 'blur': case 'contraste': case 'gray': case 'invert': case 'mirror': case 'pixel':
                if (msg.message.imageMessage || quoted?.imageMessage) {
                    const img = await Jimp.read(await downloadMediaMessage({ message: quoted || msg.message }, 'buffer', {}));
                    if (command === 'blur') img.blur(8); if (command === 'contraste') img.contrast(0.6); if (command === 'gray') img.greyscale(); if (command === 'invert') img.invert(); if (command === 'mirror') img.mirror(true, false); if (command === 'pixel') img.pixelate(12);
                    await sock.sendMessage(from, { image: await img.getBufferAsync(Jimp.MIME_JPEG) });
                }
                break;
        }
    });
}
iniciarBot();

