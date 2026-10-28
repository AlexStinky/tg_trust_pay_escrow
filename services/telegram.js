const fs = require('fs');
const path = require('path');

const {
    TelegramClient,
    Api
} = require("telegram");
const { StringSession } = require("telegram/sessions");
const QRCode = require('qrcode');

const messages = require('../scripts/messages');
const { Queue } = require('../modules/queue_lifo');

const { sender } = require('./sender');
const {
    dealDBService,
    userDBService,
    systemConfigService,
    getNextDealNumber
} = require('./db');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class TelegramMethods {
    constructor(appId = Number(process.env.TELEGRAM_APP_ID), appHash = process.env.TELEGRAM_APP_HASH) {
        this.queue = new Queue();
        this.enqueue = (data) => this.queue.enqueue(data);
        this.dequeue = () => this.queue.dequeue();

        this.APP_ID = appId;
        this.APP_HASH = appHash;

        this.SESSION_FILE = './telegram_session.txt';

        this.stringSession = fs.existsSync(this.SESSION_FILE) ?
            new StringSession(fs.readFileSync(this.SESSION_FILE, "utf8")) :
            new StringSession("");
        this.client = {};
        this.isReady = false;
    }

    async create(k = 0) {
        let CONFIG = null;
        const configPath = path.resolve(__dirname, '../config.json');
        try {
            if (fs.existsSync(configPath)) {
                CONFIG = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
            }
        } catch (e) {
            console.error('[Userbot] Ошибка чтения config.json:', e.message);
        }

        const logsId = CONFIG && CONFIG.CHATS && CONFIG.CHATS.LOGS_ID
            ? CONFIG.CHATS.LOGS_ID
            : (process.env.ADMINS ? process.env.ADMINS.split(',')[0].trim() : null);

        let authThreadId = CONFIG && CONFIG.CHATS && CONFIG.CHATS.AUTH_THREAD_ID
            ? CONFIG.CHATS.AUTH_THREAD_ID
            : null;

        // Если logsId является личным чатом пользователя (начинается не с -), у него нет тредов/топиков
        if (logsId && !String(logsId).startsWith('-')) {
            authThreadId = null;
        }

        // Если сессия уже сохранена в файле, сначала пробуем подключиться без запроса QR
        if (fs.existsSync(this.SESSION_FILE)) {
            const savedStr = fs.readFileSync(this.SESSION_FILE, "utf8").trim();
            if (savedStr.length > 20) {
                try {
                    this.stringSession = new StringSession(savedStr);
                    this.client = new TelegramClient(this.stringSession, this.APP_ID, this.APP_HASH, {
                        connectionRetries: 5,
                        useIPV6: false
                    });
                    await this.client.connect();
                    const me = await this.client.getMe();
                    if (me) {
                        this.isReady = true;
                        console.log(`✅ [Userbot] Авторизован из сохраненной сессии: @${me.username || me.id}`);
                        await sender.sendMessage(logsId, messages.auth('ru', `✅ Юзербот подключен: @${me.username || me.id}`, authThreadId));
                        return await this.run();
                    }
                } catch (e) {
                    console.log('[Userbot] Сохраненная сессия устарела, генерирую QR-код...');
                }
            }
        }

        this.stringSession = new StringSession("");
        this.client = new TelegramClient(this.stringSession, this.APP_ID, this.APP_HASH, {
            connectionRetries: 5,
            useIPV6: false
        });

        await this.client.connect();

        try {
            console.log(`[Userbot] Генерация QR-кода для авторизации в чат: ${logsId}`);

            let qrMessageId = null;

            const user = await this.client.signInUserWithQrCode(
                { apiId: this.APP_ID, apiHash: this.APP_HASH },
                {
                    qrCode: async (code) => {
                        const url = `tg://login?token=${code.token.toString("base64url")}`;
                        console.log('[Userbot] Отправка QR-кода в групповой чат:', url);

                        try {
                            const qrBuffer = await QRCode.toBuffer(url, {
                                width: 350,
                                margin: 2,
                                color: { dark: '#000000', light: '#FFFFFF' }
                            });

                            const caption = `📲 <b>Авторизация Юзербота через QR-код</b>\n\n` +
                                `1. Откройте Telegram на телефоне\n` +
                                `2. Перейдите в <b>Настройки ➔ Устройства</b>\n` +
                                `3. Нажмите <b>«Подключить устройство»</b> и наведите камеру на этот QR-код\n\n` +
                                `⏳ <i>QR-код обновляется каждые 30 секунд.</i>`;

                            const extra = authThreadId ? { message_thread_id: Number(authThreadId) } : {};

                            if (qrMessageId) {
                                try {
                                    await sender.deleteMessage(logsId, qrMessageId);
                                } catch (e) {}
                            }

                            const sent = await sender.sendMessage(logsId, {
                                type: 'photo',
                                file: qrBuffer,
                                text: caption,
                                extra
                            });

                            if (sent && sent.message_id) {
                                qrMessageId = sent.message_id;
                            }
                        } catch (errQr) {
                            console.error('[Userbot QR Generate Error]:', errQr.message);
                        }
                    },
                    password: async (hint) => {
                        console.log(`[Userbot] Требуется 2FA пароль...`);
                        const ans = await sender.waitForUserMessage(
                            logsId,
                            messages.auth('ru', `🔐 Введите 2FA пароль от аккаунта (Подсказка: ${hint || 'нет'}):`, authThreadId),
                            authThreadId
                        );
                        return String(ans).trim();
                    },
                    onError: async (err) => {
                        console.error('[Userbot QR Error]:', err);
                        await sender.sendMessage(logsId, messages.auth('ru', `⚠️ Ошибка QR: ${err.message || err}`, authThreadId));
                    }
                }
            );

            this.isReady = true;

            if (qrMessageId) {
                try {
                    await sender.deleteMessage(logsId, qrMessageId);
                } catch (e) {}
            }

            await sender.sendMessage(logsId, messages.auth('ru', `✅ <b>Успешно! Юзербот авторизован:</b> @${user.username || user.firstName || user.id}`, authThreadId));

            this.stringSession = this.client.session.save();
            fs.writeFileSync(this.SESSION_FILE, this.stringSession);
            console.log(`✅ [Userbot] Авторизован @${user.username || user.id}, сессия сохранена в ${this.SESSION_FILE}`);
        } catch (err) {
            console.error(`[Userbot start error attempt=${k}]:`, err.message || err);
            await sleep(3000);

            k++;

            if (k < 10) {
                return await this.create(k);
            }
        }

        await this.run();
    }

    async run() {
        const {
            _storage,
            _oldestIndex,
            _newestIndex
        } = this.queue;

        for (let i = _oldestIndex; i < _newestIndex; i++) {
            const item = _storage[i];
            if (!item) continue;

            const {
                action,
                data
            } = item;

            if (action === 'createChat') {
                const {
                    botUsername,
                    title,
                    user,
                    users,
                    deal_id
                } = data;

                console.log('[Userbot Task createChat]:', data);

                const chat = await this.createChat(botUsername, users || [], title);

                if (chat) {
                    let deal;
                    if (deal_id) {
                        deal = await dealDBService.update({ _id: deal_id }, {
                            chat_id: chat.id,
                            chat_url: chat.url,
                            chat_title: title
                        });
                    } else {
                        const dealNumber = await getNextDealNumber();
                        const escrowWallet = await systemConfigService.getNextEscrowWallet();
                        const config = await systemConfigService.getConfig();

                        deal = await dealDBService.create({
                            deal_number: dealNumber,
                            chat_id: chat.id,
                            chat_url: chat.url,
                            chat_title: title,
                            fee_percent: config.fee_percent,
                            assigned_escrow_wallet: escrowWallet,
                            buyer: {
                                chat_id: String(user.chat_id),
                                username: user.username || '',
                                first_name: user.first_name || '',
                                return_wallet: user.trc20_wallet || ''
                            }
                        });
                    }

                    if (user && user.chat_id) {
                        await userDBService.update({ chat_id: user.chat_id }, {
                            last_create_date: new Date()
                        });

                        await sender.sendMessage(user.chat_id, {
                            text: `🎉 <b>Группа сделки создана!</b>\n\nСсылка: <a href="${chat.url}"><b>Вступить в группу</b></a>\n<code>${chat.url}</code>`
                        });
                    }

                    sender.enqueue({
                        chat_id: chat.id,
                        message: messages.dealGroupWelcome(deal)
                    });
                }
            }

            await sleep(1000);

            this.dequeue();
        }

        setTimeout(async () => await this.run(), 1000);
    }

    async createChat(botUsername, users = [], title = 'Deal') {
        try {
            const chat = await this.client.invoke(
                new Api.messages.CreateChat({
                    users: [botUsername],
                    title
                })
            );

            const chatId = chat.updates.chats[0].id;

            const invite = await this.client.invoke(
                new Api.messages.ExportChatInvite({
                    peer: new Api.InputPeerChat({ chatId }),
                })
            );

            const upgraded = await this.client.invoke(
                new Api.messages.MigrateChat({
                    chatId,
                })
            );

            const supergroup = upgraded.chats[0];

            const { migratedTo } = await this.client.getEntity(supergroup.id);
            const channel = new Api.InputChannel({
                channelId: migratedTo.channelId,
                accessHash: migratedTo.accessHash,
            });

            await this.client.invoke(
                new Api.channels.TogglePreHistoryHidden({
                    channel,
                    enabled: false,
                })
            );

            await this.client.invoke(
                new Api.channels.EditAdmin({
                    channel,
                    userId: botUsername,
                    adminRights: new Api.ChatAdminRights({
                        changeInfo: true,
                        postMessages: true,
                        editMessages: true,
                        deleteMessages: true,
                        banUsers: true,
                        inviteUsers: true,
                        pinMessages: true,
                        addAdmins: true,
                        manageCall: true,
                        other: true,
                    }),
                    rank: "Гарант",
                })
            );

            for (let el of users) {
                try {
                    await this.client.invoke(
                        new Api.channels.InviteToChannel({
                            channel,
                            users: [el]
                        })
                    );

                    await this.client.invoke(
                        new Api.channels.EditAdmin({
                            channel,
                            userId: el,
                            adminRights: new Api.ChatAdminRights({
                                changeInfo: true,
                                postMessages: true,
                                editMessages: true,
                                deleteMessages: true,
                                banUsers: true,
                                inviteUsers: true,
                                pinMessages: true,
                                addAdmins: true,
                                manageCall: true,
                                other: true,
                            }),
                            rank: "Гарант",
                        })
                    );
                } catch {
                    //...
                }
            }

            await this.client.invoke(
                new Api.channels.LeaveChannel({
                    channel,
                })
            );

            return {
                type: 'supergroup',
                id: `-100${Number(migratedTo.channelId)}`,
                url: invite.link,
                title
            };
        } catch (error) {
            console.log('[createChat]', error);
        }

        return null;
    }

    async createDealChat(botUsername, dealNumber, title) {
        const chatTitle = title || `Сделка #${dealNumber}`;
        return await this.createChat(botUsername, [], chatTitle);
    }
}

const telegramService = new TelegramMethods();

module.exports = {
    telegramService,
    userbotService: telegramService
};
