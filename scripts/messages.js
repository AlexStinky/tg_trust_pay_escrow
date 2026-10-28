const helper = require('./helper');

const messages = {
    // Сообщение авторизации юзербота
    auth(lang, text, thread_id = null) {
        const extra = thread_id ? { message_thread_id: Number(thread_id) } : {};
        return {
            type: 'text',
            text: `🤖 <b>[Юзербот]</b> ${text}`,
            extra
        };
    },

    // Главное меню в ЛС с ботом (Reply-клавиатура)
    mainMenuReplyKeyboard(isAdmin = false) {
        const keyboard = [
            ['🤝 Создать сделку', '📋 Мои сделки'],
            ['💼 Мой кошелек USDT', 'ℹ️ Помощь / О сервисе']
        ];
        if (isAdmin) {
            keyboard.push(['⚙️ Админ-панель', '📊 Финансовая статистика']);
        }
        return {
            reply_markup: {
                keyboard: keyboard.map(row => row.map(text => ({ text }))),
                resize_keyboard: true
            }
        };
    },

    // Старт в ЛС
    startPrivate(user, config) {
        return {
            text: `🛡 <b>Добро пожаловать в полуавтоматический гарант-сервис безопасных сделок!</b>\n\n` +
                `Бот обеспечивает 100% безопасность расчетов в <b>USDT TRC20</b> между покупателями и продавцами.\n\n` +
                `✨ <b>Как это работает:</b>\n` +
                `1️⃣ Вы или ваш партнер создаете сделку командой или кнопкой ниже.\n` +
                `2️⃣ Вступаете в группу или привязываете сделку к чату.\n` +
                `3️⃣ Согласовываете условия, сумму и комиссию сервиса.\n` +
                `4️⃣ Покупатель отправляет депозит на защищенный кошелек гаранта.\n` +
                `5️⃣ Блокчейн автоматически подтверждает поступление и статус меняется на «Оплачено».\n` +
                `6️⃣ Продавец выполняет работу, после чего гарант переводит средства продавцу.\n\n` +
                `💰 <b>Комиссия гаранта:</b> ${config.fee_percent}% (минимум ${config.min_fee_usdt} USDT).\n` +
                `🔒 <i>Все исходящие выплаты и возвраты проверяются и подтверждаются гарантом вручную.</i>`,
            extra: this.mainMenuReplyKeyboard(user.role === 'admin' || user.role === 'guarantor')
        };
    },

    // Приветствие в группе сделки
    dealGroupWelcome(deal) {
        const text = `🤝 <b>Чат безопасной сделки #${deal.deal_number}</b>\n\n` +
            `Добро пожаловать! Данный чат привязан к сделке между Покупателем и Продавцом под защитой Гаранта.\n\n` +
            `📌 <b>Статус:</b> Ожидание присоединения сторон и согласования условий.\n` +
            `Используйте интерактивные кнопки ниже для управления сделкой:`;

        const inline_keyboard = [
            [
                { text: '🙋‍♂️ Я Покупатель', callback_data: `deal_role_buyer_${deal._id}` },
                { text: '👨‍💼 Я Продавец', callback_data: `deal_role_seller_${deal._id}` }
            ],
            [
                { text: '📝 Настроить условия и сумму', callback_data: `deal_edit_terms_${deal._id}` }
            ],
            [
                { text: '📋 Карточка сделки', callback_data: `deal_info_${deal._id}` }
            ]
        ];

        return {
            text,
            extra: { reply_markup: { inline_keyboard } }
        };
    },

    // Карточка сделки для участников (групповой чат или ЛС)
    dealCardUser(deal, viewerChatId = null, isGuarantor = false) {
        const buyerName = deal.buyer && deal.buyer.username ? `@${deal.buyer.username}` : (deal.buyer && deal.buyer.first_name ? deal.buyer.first_name : 'Не назначен');
        const sellerName = deal.seller && deal.seller.username ? `@${deal.seller.username}` : (deal.seller && deal.seller.first_name ? deal.seller.first_name : 'Не назначен');

        const buyerConfirmed = deal.buyer && deal.buyer.terms_confirmed ? '✅ Согласовано' : '⏳ Ожидает подтверждения';
        const sellerConfirmed = deal.seller && deal.seller.terms_confirmed ? '✅ Согласовано' : '⏳ Ожидает подтверждения';

        // Безопасность: Кошелек продавца виден только продавцу и гаранту!
        let sellerWalletDisplay = '🔒 <i>Скрыт в целях безопасности</i>';
        if (isGuarantor || (deal.seller && String(deal.seller.chat_id) === String(viewerChatId))) {
            sellerWalletDisplay = deal.seller && deal.seller.payout_wallet ? `<code>${deal.seller.payout_wallet}</code>` : '<i>не указан</i>';
        }

        let statusText = 'Создана';
        if (deal.status === 'terms_agreed') statusText = '⏳ Ожидает внесения депозита';
        else if (deal.status === 'paid') statusText = '💰 Депозит внесен (В работе)';
        else if (deal.status === 'completed') statusText = '📦 Выполнено (Ожидает выплаты гарантом)';
        else if (deal.status === 'paid_out') statusText = '✅ Сделка успешно завершена (Выплачено)';
        else if (deal.status === 'refunded') statusText = '↩️ Сделка отменена (Депозит возвращен)';
        else if (deal.status === 'dispute') statusText = '🚨 Открыт арбитраж / спор';
        else if (deal.status === 'paused') statusText = '⏸ Приостановлена администратором';
        else if (deal.status === 'canceled') statusText = '❌ Отменена';

        let text = `📑 <b>Сделка #${deal.deal_number}</b>\n\n`;
        text += `📊 <b>Статус:</b> ${statusText}\n\n`;
        text += `👤 <b>Покупатель:</b> ${buyerName} (${buyerConfirmed})\n`;
        text += `👤 <b>Продавец:</b> ${sellerName} (${sellerConfirmed})\n\n`;

        text += `💵 <b>Сумма сделки:</b> ${deal.amount || 0} USDT TRC20\n`;
        text += `⚖️ <b>Комиссия гаранта (${deal.fee_percent || 5}%):</b> ${deal.fee_amount || 0} USDT\n`;
        text += `💳 <b>Оплата комиссии:</b> ${deal.fee_payer === 'seller' ? 'Продавец' : (deal.fee_payer === '50/50' ? '50/50' : 'Покупатель')}\n\n`;

        text += `📥 <b>Сумма к оплате покупателем:</b> <b>${deal.total_deposit_amount || 0} USDT</b>\n`;
        text += `📤 <b>Сумма к выплате продавцу:</b> <b>${deal.seller_receive_amount || 0} USDT</b>\n\n`;

        if (deal.terms && deal.terms.description) {
            text += `📝 <b>Условия сделки:</b>\n<i>${deal.terms.description}</i>\n`;
        }
        if (deal.terms && deal.terms.deadline) {
            text += `⏱ <b>Срок:</b> ${deal.terms.deadline}\n`;
        }

        text += `\n💳 <b>Кошелек продавца:</b> ${sellerWalletDisplay}\n`;

        if (deal.status === 'terms_agreed') {
            text += `\n🏛 <b>РЕКВИЗИТЫ ДЛЯ ОПЛАТЫ ДЕПОЗИТА (USDT TRC20):</b>\n`;
            text += `<code>${deal.assigned_escrow_wallet}</code>\n`;
            text += `⚠️ <i>Покупатель, переводите ровно указанную сумму. Зачисление отслеживается автоматически!</i>\n`;
        }

        if (deal.deposit_txid) {
            text += `\n🔗 <b>TXID депозита:</b> <code>${deal.deposit_txid}</code>\n`;
        }

        if (deal.payout && deal.payout.txid) {
            text += `\n💸 <b>TXID выплаты:</b> <code>${deal.payout.txid}</code>\n`;
        }

        return text;
    },

    // Инлайн-клавиатура для сделки в чате
    dealInlineKeyboard(deal, viewerChatId = null) {
        const keyboard = [];

        if (deal.status === 'created') {
            const roleRow = [];
            if (!deal.buyer || !deal.buyer.chat_id) {
                roleRow.push({ text: '🙋‍♂️ Стать Покупателем', callback_data: `deal_role_buyer_${deal._id}` });
            }
            if (!deal.seller || !deal.seller.chat_id) {
                roleRow.push({ text: '👨‍💼 Стать Продавцом', callback_data: `deal_role_seller_${deal._id}` });
            }
            if (roleRow.length > 0) keyboard.push(roleRow);

            keyboard.push([
                { text: '✏️ Изменить сумму и условия', callback_data: `deal_edit_terms_${deal._id}` }
            ]);

            // Кнопка подтверждения условий
            keyboard.push([
                { text: '✅ Подтвердить условия', callback_data: `deal_confirm_terms_${deal._id}` }
            ]);
        } else if (deal.status === 'terms_agreed') {
            keyboard.push([
                { text: '💳 Реквизиты и QR-код оплаты', callback_data: `deal_payment_qr_${deal._id}` },
                { text: '🔄 Проверить зачисление', callback_data: `deal_check_deposit_${deal._id}` }
            ]);
        } else if (deal.status === 'paid') {
            keyboard.push([
                { text: '✅ Подтвердить получение (Выплата продавцу)', callback_data: `deal_release_${deal._id}` },
                { text: '⚠️ Открыть спор', callback_data: `deal_dispute_${deal._id}` }
            ]);
        } else if (deal.status === 'completed' || deal.status === 'payout_pending') {
            keyboard.push([
                { text: '⏳ Ожидает ручной выплаты гарантом', callback_data: `deal_info_${deal._id}` }
            ]);
        }

        keyboard.push([
            { text: '📋 Обновить информацию', callback_data: `deal_info_${deal._id}` }
        ]);

        return { inline_keyboard: keyboard };
    }
};

module.exports = messages;
