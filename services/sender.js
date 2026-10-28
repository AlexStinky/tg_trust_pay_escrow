const PQueue = require("p-queue").default;
const { userDBService } = require('./db');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class Sender {
    constructor() {
        this.queue = new PQueue({ interval: 1000, intervalCap: 25 });
        this.bot = null;
        this.delay = 80;
        this.pendingAuthInput = null;

        this.FORBIDDEN_ERRORS = [
            'bot was blocked',
            "bot can't initiate conversation with a user",
            'user is deactivated',
            'chat not found'
        ];
    }

    checkForbidden(text) {
        if (!text) return false;
        return this.FORBIDDEN_ERRORS.some(el => text.includes(el));
    }

    async create(bot) {
        if (!bot) throw new Error('Bot instance is required');
        this.bot = bot;
        return this.bot;
    }

    enqueue(data) {
        const { chat_id, message } = data;
        return this.queue.add(async () => {
            return await this.sendMessage(chat_id, message);
        });
    }

    /**
     * Ожидание ответа пользователя/админа в чате для авторизации юзербота
     */
    async waitForUserMessage(chat_id, message, threadId = null) {
        return new Promise((resolve) => {
            const extra = threadId ? { message_thread_id: Number(threadId) } : {};
            let msgObj;
            if (typeof message === 'string') {
                msgObj = { text: message, extra };
            } else if (message && message.text) {
                msgObj = { ...message, extra: { ...extra, ...message.extra } };
            } else {
                msgObj = { text: String(message), extra };
            }

            console.log(`[Sender] Ожидаю ввод от чата ${chat_id}: ${msgObj.text}`);
            this.sendMessage(chat_id, msgObj);

            this.pendingAuthInput = {
                chat_id: String(chat_id),
                thread_id: threadId ? Number(threadId) : null,
                resolve
            };
        });
    }

    resolveUserMessage(chat_id, text, threadId = null) {
        if (!this.pendingAuthInput) return false;

        const incomingChatId = String(chat_id);
        const expectedChatId = this.pendingAuthInput.chat_id;

        // Принимаем ввод если совпадает chat_id (или если это личный чат админа)
        if (incomingChatId === expectedChatId || !expectedChatId) {
            console.log(`[Sender] Получен ответ для юзербота: "${text}"`);
            const resolveFn = this.pendingAuthInput.resolve;
            this.pendingAuthInput = null;
            resolveFn(text);
            return true;
        }

        return false;
    }

    async sendMessage(chat_id, message) {
        if (!this.bot || !chat_id || !message) return null;

        await sleep(this.delay);

        try {
            let res = null;
            const extra = {
                parse_mode: 'HTML',
                caption: message.caption || message.text,
                ...message.extra
            };

            switch (message.type) {
                case 'photo':
                    const photoPayload = Buffer.isBuffer(message.file) ? { source: message.file } : message.file;
                    res = await this.bot.telegram.sendPhoto(chat_id, photoPayload, extra);
                    break;
                case 'edit_text':
                    res = await this.bot.telegram.editMessageText(chat_id, message.message_id, null, message.text, extra);
                    break;
                case 'cb':
                    res = await this.bot.telegram.answerCbQuery(message.id, message.text, message.alert, extra);
                    break;
                default:
                    res = await this.bot.telegram.sendMessage(chat_id, message.text, extra);
                    break;
            }
            return res;
        } catch (error) {
            const desc = error.response ? error.response.description : error.message;

            // Если топик/тред не найден, пробуем отправить в общий чат без message_thread_id
            if (desc && desc.includes("message thread not found") && message.extra && message.extra.message_thread_id) {
                try {
                    const fallbackExtra = { ...message.extra };
                    delete fallbackExtra.message_thread_id;
                    const finalExtra = { parse_mode: 'HTML', ...fallbackExtra };
                    if (message.type === 'photo') {
                        const photoPayload = Buffer.isBuffer(message.file) ? { source: message.file } : message.file;
                        return await this.bot.telegram.sendPhoto(chat_id, photoPayload, finalExtra);
                    } else {
                        return await this.bot.telegram.sendMessage(chat_id, message.text, finalExtra);
                    }
                } catch (fallbackErr) {
                    console.error(`[Sender Fallback Error chat=${chat_id}]:`, fallbackErr.message);
                }
            }

            if (this.checkForbidden(desc)) {
                await userDBService.update({ chat_id }, { is_blocked: true });
            } else if (desc && desc.includes("message is not modified")) {
                // Игнорируем
            } else {
                console.error(`[Sender Error chat=${chat_id}]:`, desc || error);
            }
            return null;
        }
    }

    async deleteMessage(chat_id, message_id) {
        try {
            return await this.bot.telegram.deleteMessage(chat_id, message_id);
        } catch (e) {
            return null;
        }
    }
}

const sender = new Sender();

module.exports = {
    sender
};
