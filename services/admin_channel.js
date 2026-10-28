const { dealDBService, systemConfigService } = require('./db');

class AdminChannelService {
    constructor() {
        this.bot = null;
    }

    init(bot) {
        this.bot = bot;
    }

    getStatusBadge(status) {
        const badges = {
            'created': '🆕 Создана',
            'terms_agreed': '⏳ Ожидает депозит',
            'paid': '💰 Депозит внесен (В работе)',
            'completed': '📦 Выполнена (Ожидает выплаты)',
            'payout_pending': '🔄 На выплате гарантом',
            'paid_out': '✅ Выплачена продавцу',
            'refund_pending': '🔄 На возврате покупателю',
            'refunded': '↩️ Возвращена покупателю',
            'dispute': '🚨 СПОР / АРБИТРАЖ',
            'paused': '⏸ Приостановлена',
            'canceled': '❌ Отменена'
        };
        return badges[status] || status;
    }

    formatDealCardText(deal) {
        const buyerName = deal.buyer && deal.buyer.username ? `@${deal.buyer.username}` : (deal.buyer && deal.buyer.first_name ? deal.buyer.first_name : 'Не назначен');
        const buyerId = deal.buyer && deal.buyer.chat_id ? deal.buyer.chat_id : '—';
        
        const sellerName = deal.seller && deal.seller.username ? `@${deal.seller.username}` : (deal.seller && deal.seller.first_name ? deal.seller.first_name : 'Не назначен');
        const sellerId = deal.seller && deal.seller.chat_id ? deal.seller.chat_id : '—';

        // Кошелек продавца виден только гаранту в админ-канале (для ручной выплаты)
        const sellerWallet = deal.seller && deal.seller.payout_wallet ? `<code>${deal.seller.payout_wallet}</code>` : '<i>не указан</i>';
        const buyerWallet = deal.buyer && deal.buyer.return_wallet ? `<code>${deal.buyer.return_wallet}</code>` : '<i>не указан</i>';

        const sourceChat = deal.source_chat_title ? deal.source_chat_title : (deal.chat_title ? deal.chat_title : 'Личные сообщения');

        let text = `📑 <b>Карточка сделки #${deal.deal_number}</b>\n\n`;
        text += `📊 <b>Статус:</b> ${this.getStatusBadge(deal.status)}\n`;
        text += `👥 <b>Сообщество/Чат:</b> ${sourceChat}\n`;
        if (deal.chat_url) {
            text += `🔗 <b>Чат сделки:</b> <a href="${deal.chat_url}">Перейти в чат</a>\n`;
        }
        text += `\n`;
        text += `👤 <b>Покупатель:</b> ${buyerName} [<code>${buyerId}</code>]\n`;
        text += `👤 <b>Продавец:</b> ${sellerName} [<code>${sellerId}</code>]\n`;
        text += `\n`;
        text += `💵 <b>Сумма сделки:</b> ${deal.amount || 0} USDT\n`;
        text += `⚖️ <b>Комиссия гаранта (${deal.fee_percent || 5}%):</b> ${deal.fee_amount || 0} USDT (Оплачивает: ${deal.fee_payer === 'seller' ? 'Продавец' : (deal.fee_payer === '50/50' ? '50/50' : 'Покупатель')})\n`;
        text += `📥 <b>Депозит к оплате:</b> ${deal.total_deposit_amount || 0} USDT\n`;
        text += `📤 <b>К выплате продавцу:</b> ${deal.seller_receive_amount || 0} USDT\n`;
        text += `\n`;
        text += `🏛 <b>Кошелек гаранта:</b> <code>${deal.assigned_escrow_wallet || 'Не назначен'}</code>\n`;
        if (deal.deposit_txid) {
            text += `🔗 <b>TXID депозита:</b> <code>${deal.deposit_txid}</code>\n`;
        }

        // Реквизиты сторон (доступны гаранту для выплат)
        text += `\n💳 <b>Кошелек продавца для выплаты:</b>\n${sellerWallet}\n`;
        if (deal.buyer && deal.buyer.return_wallet) {
            text += `💳 <b>Кошелек покупателя для возврата:</b>\n${buyerWallet}\n`;
        }

        if (deal.terms && deal.terms.description) {
            text += `\n📝 <b>Условия сделки:</b>\n<i>${deal.terms.description}</i>\n`;
        }
        if (deal.terms && deal.terms.deadline) {
            text += `⏱ <b>Срок выполнения:</b> ${deal.terms.deadline}\n`;
        }

        if (deal.dispute && deal.dispute.is_active) {
            text += `\n🚨 <b>СПОР ОТКРЫТ!</b> Причина: <i>${deal.dispute.reason || 'не указана'}</i>\n`;
        }

        if (deal.payout && deal.payout.txid) {
            text += `\n💸 <b>Подтвержденная выплата:</b> ${deal.payout.type === 'seller_payout' ? 'Продавцу' : 'Возврат покупателю'}\n`;
            text += `🔗 <b>TXID выплаты:</b> <code>${deal.payout.txid}</code>\n`;
            text += `Сумма: ${deal.payout.amount} USDT\n`;
        }

        return text;
    }

    getDealCardKeyboard(deal) {
        const keyboard = [];

        // Кнопки управления в зависимости от статуса сделки
        if (deal.status === 'paid' || deal.status === 'completed' || deal.status === 'payout_pending') {
            keyboard.push([
                { text: '💸 Подтвердить выплату Продавцу', callback_data: `adm_payout_seller_${deal._id}` },
                { text: '↩️ Оформить возврат Покупателю', callback_data: `adm_refund_buyer_${deal._id}` }
            ]);
        }

        if (deal.status === 'dispute') {
            keyboard.push([
                { text: '⚖️ Решить в пользу Продавца', callback_data: `adm_resolve_seller_${deal._id}` },
                { text: '⚖️ Решить в пользу Покупателя', callback_data: `adm_resolve_buyer_${deal._id}` }
            ]);
        }

        const controlRow = [];
        if (deal.status !== 'paused' && deal.status !== 'canceled' && deal.status !== 'paid_out' && deal.status !== 'refunded') {
            controlRow.push({ text: '⏸ Приостановить', callback_data: `adm_pause_${deal._id}` });
            controlRow.push({ text: '❌ Отменить сделку', callback_data: `adm_cancel_${deal._id}` });
        } else if (deal.status === 'paused') {
            controlRow.push({ text: '▶️ Возобновить сделку', callback_data: `adm_resume_${deal._id}` });
            controlRow.push({ text: '❌ Отменить сделку', callback_data: `adm_cancel_${deal._id}` });
        }

        if (controlRow.length > 0) {
            keyboard.push(controlRow);
        }

        keyboard.push([
            { text: '🔄 Обновить карточку', callback_data: `adm_refresh_${deal._id}` }
        ]);

        return keyboard;
    }

    /**
     * Опубликовать новую карточку сделки в закрытый административный канал
     */
    async postNewDealCard(deal) {
        try {
            if (!this.bot) return;
            const config = await systemConfigService.getConfig();
            const channelId = config.admin_channel_id || process.env.ADMIN_CHANNEL_ID;

            if (!channelId) {
                console.log('[AdminChannel] admin_channel_id не настроен в конфигурации');
                return;
            }

            const text = this.formatDealCardText(deal);
            const keyboard = this.getDealCardKeyboard(deal);

            const msg = await this.bot.telegram.sendMessage(channelId, text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: { inline_keyboard: keyboard }
            });

            if (msg && msg.message_id) {
                await dealDBService.update({ _id: deal._id }, {
                    admin_channel_message_id: msg.message_id
                });
            }
        } catch (error) {
            console.error('[AdminChannel postNewDealCard Error]:', error.message);
        }
    }

    /**
     * Динамически обновить существующую карточку сделки в закрытом канале
     */
    async updateDealCard(deal) {
        try {
            if (!this.bot) return;
            const config = await systemConfigService.getConfig();
            const channelId = config.admin_channel_id || process.env.ADMIN_CHANNEL_ID;

            if (!channelId) return;

            // Если карточка еще не публиковалась - публикуем
            if (!deal.admin_channel_message_id) {
                return await this.postNewDealCard(deal);
            }

            const text = this.formatDealCardText(deal);
            const keyboard = this.getDealCardKeyboard(deal);

            await this.bot.telegram.editMessageText(
                channelId,
                deal.admin_channel_message_id,
                null,
                text,
                {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: { inline_keyboard: keyboard }
                }
            );
        } catch (error) {
            // Если сообщение не изменилось или было удалено, обрабатываем мягко
            if (!error.message.includes('message is not modified')) {
                console.error('[AdminChannel updateDealCard Error]:', error.message);
            }
        }
    }
}

const adminChannelService = new AdminChannelService();

module.exports = {
    adminChannelService
};

