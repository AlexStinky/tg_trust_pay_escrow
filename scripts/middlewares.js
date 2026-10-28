const {
    userDBService,
    dealDBService,
    systemConfigService,
    connectedChatDBService,
    auditService,
    getNextDealNumber
} = require('../services/db');
const { blockchainService } = require('../services/blockchain');
const { adminChannelService } = require('../services/admin_channel');
const { userbotService } = require('../services/telegram');
const { sender } = require('../services/sender');
const messages = require('./messages');
const helper = require('./helper');

const ADMINS_LIST = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);

// Состояния пользователей для пошагового ввода (FSM)
const userStates = new Map();

function setUserState(chatId, state, data = {}) {
    userStates.set(String(chatId), { state, data, timestamp: Date.now() });
}

function getUserState(chatId) {
    return userStates.get(String(chatId)) || null;
}

function clearUserState(chatId) {
    userStates.delete(String(chatId));
}

/**
 * Middleware инициализации пользователя и регистрации добавления в группы
 */
const userMiddleware = async (ctx, next) => {
    try {
        const from = ctx.from;
        const chat = ctx.chat;

        if (from) {
            const isAdmin = ADMINS_LIST.includes(String(from.id));

            // Атомарный upsert для предотвращения гонки E11000 duplicate key error
            const updateDoc = {
                $setOnInsert: {
                    chat_id: String(from.id)
                },
                $set: {
                    username: from.username || '',
                    first_name: from.first_name || '',
                    role: isAdmin ? 'admin' : 'user'
                }
            };

            const user = await userDBService.update(
                { chat_id: String(from.id) },
                updateDoc,
                'after',
                true // upsert
            );

            ctx.state.user = user;
        }

        // Если бот добавлен в групповой чат, регистрируем сообщество в базе
        if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
            await connectedChatDBService.update(
                { chat_id: String(chat.id) },
                {
                    $setOnInsert: {
                        chat_id: String(chat.id),
                        title: chat.title || 'Группа',
                        type: chat.type,
                        username: chat.username || ''
                    }
                },
                'after',
                true // upsert
            );
        }
    } catch (e) {
        console.error('[UserMiddleware Error]:', e);
    }
    return next();
};

/**
 * Обработка текстовых команд и сообщений
 */
const textHandler = async (ctx) => {
    const text = ctx.message && ctx.message.text ? ctx.message.text.trim() : '';
    const chat = ctx.chat;
    const user = ctx.state.user;
    if (!text || !chat || !user) return;

    const isPrivate = chat.type === 'private';
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    const isGuarantor = user.role === 'admin' || user.role === 'guarantor';

    // Проверяем, не является ли это сообщением в ответ на запрос авторизации юзербота
    const threadId = ctx.message.message_thread_id || null;
    const resolved = sender.resolveUserMessage(chat.id, text, threadId);
    if (resolved) {
        return; // Сообщение перехвачено для авторизации юзербота
    }

    const uState = getUserState(user.chat_id);

    // ==========================================
    // 1. ОБРАБОТКА FSM (ШАГОВ ВВОДА)
    // ==========================================
    if (uState && isPrivate) {
        if (text === '❌ Отмена' || text === '/cancel') {
            clearUserState(user.chat_id);
            return await ctx.reply('Действие отменено.', messages.mainMenuReplyKeyboard(isGuarantor));
        }

        // Ввод кошелька USDT TRC20 для личного профиля
        if (uState.state === 'AWAITING_WALLET_INPUT') {
            if (!helper.isValidTronAddress(text)) {
                return await ctx.reply('❌ Некорректный адрес USDT TRC20! Адрес Tron должен начинаться с буквы "T" и содержать 34 символа. Попробуйте еще раз или напишите "❌ Отмена":');
            }
            await userDBService.update({ chat_id: user.chat_id }, { trc20_wallet: text });
            clearUserState(user.chat_id);
            return await ctx.reply(`✅ Ваш USDT TRC20 кошелек успешно сохранен:\n<code>${text}</code>`, {
                parse_mode: 'HTML',
                ...messages.mainMenuReplyKeyboard(isGuarantor)
            });
        }

        // Добавление нового кошелька сервиса через админку
        if (uState.state === 'AWAITING_NEW_ESCROW_WALLET' && isGuarantor) {
            const parts = text.split(/\s+/);
            const address = parts[0];
            const label = parts.slice(1).join(' ') || null;

            if (!helper.isValidTronAddress(address)) {
                return await ctx.reply('❌ Некорректный адрес TRON (USDT TRC20)! Адрес должен начинаться на "T" и содержать 34 символа. Попробуйте снова или напишите "❌ Отмена":');
            }

            const res = await systemConfigService.addEscrowWallet(address, label);
            clearUserState(user.chat_id);

            if (!res.success) {
                return await ctx.reply(`⚠️ ${res.message}`, messages.mainMenuReplyKeyboard(true));
            }

            return await ctx.reply(`✅ Новый кошелек успешно добавлен в пул сервиса!\nВсего активных кошельков: <b>${res.count}</b>`, {
                parse_mode: 'HTML',
                ...messages.mainMenuReplyKeyboard(true)
            });
        }

        // Ввод суммы сделки
        if (uState.state === 'AWAITING_DEAL_AMOUNT') {
            const amount = parseFloat(text.replace(',', '.'));
            const config = await systemConfigService.getConfig();

            if (isNaN(amount) || amount < config.min_deal_amount) {
                return await ctx.reply(`❌ Некорректная сумма! Минимальная сумма сделки: ${config.min_deal_amount} USDT. Попробуйте снова:`);
            }

            const deal = await dealDBService.get({ _id: uState.data.deal_id });
            if (!deal) {
                clearUserState(user.chat_id);
                return await ctx.reply('Сделка не найдена.');
            }

            // Пересчитываем комиссии
            const feePercent = config.fee_percent;
            let feeAmount = (amount * feePercent) / 100;
            if (feeAmount < config.min_fee_usdt) feeAmount = config.min_fee_usdt;
            feeAmount = Math.round(feeAmount * 100) / 100;

            let totalDeposit = amount;
            let sellerReceive = amount;

            if (deal.fee_payer === 'buyer') {
                totalDeposit = amount + feeAmount;
                sellerReceive = amount;
            } else if (deal.fee_payer === 'seller') {
                totalDeposit = amount;
                sellerReceive = Math.max(0, amount - feeAmount);
            } else if (deal.fee_payer === '50/50') {
                const halfFee = feeAmount / 2;
                totalDeposit = amount + halfFee;
                sellerReceive = Math.max(0, amount - halfFee);
            }

            const updatedDeal = await dealDBService.update({ _id: deal._id }, {
                amount,
                fee_percent: feePercent,
                fee_amount: feeAmount,
                total_deposit_amount: Math.round(totalDeposit * 100) / 100,
                seller_receive_amount: Math.round(sellerReceive * 100) / 100,
                'buyer.terms_confirmed': false,
                'seller.terms_confirmed': false
            });

            clearUserState(user.chat_id);

            // Оповещаем чат сделки
            if (deal.chat_id) {
                await sender.sendMessage(deal.chat_id, {
                    text: `💰 <b>Сумма сделки #${deal.deal_number} обновлена:</b> ${amount} USDT\n` +
                        `Комиссия сервиса: ${feeAmount} USDT\n` +
                        `К оплате покупателем: ${updatedDeal.total_deposit_amount} USDT\n\n` +
                        `<i>Сторонам необходимо заново подтвердить условия кнопкой ниже.</i>`,
                    extra: { reply_markup: messages.dealInlineKeyboard(updatedDeal) }
                });
            }

            await adminChannelService.updateDealCard(updatedDeal);

            return await ctx.reply(`✅ Сумма сделки #${deal.deal_number} установлена: ${amount} USDT.`, messages.mainMenuReplyKeyboard(isGuarantor));
        }

        // Ввод описания условий сделки
        if (uState.state === 'AWAITING_DEAL_TERMS') {
            const deal = await dealDBService.get({ _id: uState.data.deal_id });
            if (!deal) {
                clearUserState(user.chat_id);
                return await ctx.reply('Сделка не найдена.');
            }

            const updatedDeal = await dealDBService.update({ _id: deal._id }, {
                'terms.description': text,
                'buyer.terms_confirmed': false,
                'seller.terms_confirmed': false
            });

            clearUserState(user.chat_id);

            if (deal.chat_id) {
                await sender.sendMessage(deal.chat_id, {
                    text: `📝 <b>Условия сделки #${deal.deal_number} обновлены:</b>\n<i>${text}</i>\n\n` +
                        `<i>Сторонам необходимо подтвердить условия кнопкой ниже.</i>`,
                    extra: { reply_markup: messages.dealInlineKeyboard(updatedDeal) }
                });
            }

            await adminChannelService.updateDealCard(updatedDeal);

            return await ctx.reply(`✅ Условия сделки #${deal.deal_number} сохранены.`, messages.mainMenuReplyKeyboard(isGuarantor));
        }

        // Ввод кошелька продавца для сделки
        if (uState.state === 'AWAITING_SELLER_WALLET_DEAL') {
            if (!helper.isValidTronAddress(text)) {
                return await ctx.reply('❌ Некорректный адрес USDT TRC20! Введите валидный Tron кошелек:');
            }

            const deal = await dealDBService.get({ _id: uState.data.deal_id });
            if (!deal) {
                clearUserState(user.chat_id);
                return await ctx.reply('Сделка не найдена.');
            }

            const updatedDeal = await dealDBService.update({ _id: deal._id }, {
                'seller.payout_wallet': text,
                'seller.chat_id': user.chat_id,
                'seller.username': user.username,
                'seller.first_name': user.first_name
            });

            await userDBService.update({ chat_id: user.chat_id }, { trc20_wallet: text });
            clearUserState(user.chat_id);

            if (deal.chat_id) {
                await sender.sendMessage(deal.chat_id, {
                    text: `👨‍💼 <b>Продавец</b> @${user.username || user.first_name} успешно привязал свой кошелек для выплаты к сделке #${deal.deal_number}.\n` +
                        `🔒 <i>(Кошелек скрыт в целях безопасности и доступен только гаранту для выплаты).</i>`,
                    extra: { reply_markup: messages.dealInlineKeyboard(updatedDeal) }
                });
            }

            await adminChannelService.updateDealCard(updatedDeal);

            return await ctx.reply(`✅ Ваш кошелек успешно привязан к сделке #${deal.deal_number}.`, messages.mainMenuReplyKeyboard(isGuarantor));
        }

        // Ввод причины спора
        if (uState.state === 'AWAITING_DISPUTE_REASON') {
            const deal = await dealDBService.get({ _id: uState.data.deal_id });
            if (!deal) {
                clearUserState(user.chat_id);
                return await ctx.reply('Сделка не найдена.');
            }

            const role = String(deal.buyer.chat_id) === String(user.chat_id) ? 'buyer' : 'seller';

            const updatedDeal = await dealDBService.update({ _id: deal._id }, {
                status: 'dispute',
                previous_status: deal.status,
                'dispute.is_active': true,
                'dispute.opened_by': role,
                'dispute.opened_at': new Date(),
                'dispute.reason': text
            });

            clearUserState(user.chat_id);

            await auditService.log(updatedDeal, user.chat_id, role, 'open_dispute', { reason: text });

            if (deal.chat_id) {
                await sender.sendMessage(deal.chat_id, {
                    text: `🚨 <b>Внимание! Открыт спор по сделке #${deal.deal_number}!</b>\n\n` +
                        `Инициатор: ${role === 'buyer' ? 'Покупатель' : 'Продавец'} (@${user.username || user.first_name})\n` +
                        `Причина спора: <i>${text}</i>\n\n` +
                        `Выплаты заморожены. К сделке подключается независимый гарант/арбитр для изучения доказательств.`,
                    extra: { reply_markup: messages.dealInlineKeyboard(updatedDeal) }
                });
            }

            await adminChannelService.updateDealCard(updatedDeal);

            return await ctx.reply(`✅ Спор по сделке #${deal.deal_number} зарегистрирован. Гарант уведомлен.`, messages.mainMenuReplyKeyboard(isGuarantor));
        }

        // Ввод TXID гарантом при ручной выплате / возврате
        if (uState.state === 'AWAITING_PAYOUT_TXID' && isGuarantor) {
            const { deal_id, payout_type, target_wallet, amount } = uState.data;
            const deal = await dealDBService.get({ _id: deal_id });
            if (!deal) {
                clearUserState(user.chat_id);
                return await ctx.reply('Сделка не найдена.');
            }

            await ctx.reply(`🔍 Проверяю TXID <code>${text}</code> в блокчейне Tron...`, { parse_mode: 'HTML' });

            const verification = await blockchainService.verifyTxid(text, target_wallet, amount);
            if (!verification.success) {
                return await ctx.reply(`❌ Ошибка проверки TXID:\n${verification.message}\n\nПожалуйста, убедитесь в корректности транзакции или введите другой TXID (или "❌ Отмена"):`);
            }

            const newStatus = payout_type === 'seller_payout' ? 'paid_out' : 'refunded';

            const updatedDeal = await dealDBService.update({ _id: deal._id }, {
                status: newStatus,
                payout: {
                    type: payout_type,
                    wallet: target_wallet,
                    amount: amount,
                    txid: verification.txid,
                    confirmed_by: String(user.chat_id),
                    confirmed_at: new Date()
                },
                'dispute.is_active': false
            });

            clearUserState(user.chat_id);

            await auditService.log(updatedDeal, user.chat_id, user.role, 'confirm_payout', {
                payout_type,
                wallet: target_wallet,
                amount,
                txid: verification.txid
            });

            // Уведомление в чат сделки
            if (deal.chat_id) {
                const title = payout_type === 'seller_payout' ? '✅ Выплата продавцу успешно совершена!' : '↩️ Возврат депозита покупателю совершен!';
                await sender.sendMessage(deal.chat_id, {
                    text: `${title}\n\n` +
                        `#️⃣ <b>Сделка #${deal.deal_number}</b>\n` +
                        `💵 <b>Сумма:</b> ${amount} USDT TRC20\n` +
                        `💳 <b>Получатель:</b> <code>${target_wallet}</code>\n` +
                        `🔗 <b>TXID перевода:</b> <code>${verification.txid}</code>\n\n` +
                        `🛡 Гарант-сервис подтвердил успешное завершение операции. Спасибо за доверие!`,
                    extra: { reply_markup: messages.dealInlineKeyboard(updatedDeal) }
                });
            }

            await adminChannelService.updateDealCard(updatedDeal);

            return await ctx.reply(`✅ Выплата по сделке #${deal.deal_number} успешно подтверждена и зафиксирована в блокчейне!`, messages.mainMenuReplyKeyboard(isGuarantor));
        }

        // Назначение администратора
        if (uState.state === 'AWAITING_NEW_ADMIN_ID' && user.role === 'admin') {
            const targetUser = await userDBService.get({
                $or: [{ chat_id: text }, { username: text.replace('@', '') }]
            });

            if (!targetUser) {
                return await ctx.reply('❌ Пользователь не найден. Убедитесь, что он запускал этого бота, и введите его ID или @username:');
            }

            await userDBService.update({ chat_id: targetUser.chat_id }, { role: 'admin' });
            clearUserState(user.chat_id);
            return await ctx.reply(`✅ Пользователь @${targetUser.username || targetUser.chat_id} назначен администратором!`, messages.mainMenuReplyKeyboard(true));
        }

        // Изменение процента комиссии
        if (uState.state === 'AWAITING_CONFIG_FEE' && user.role === 'admin') {
            const fee = parseFloat(text.replace(',', '.'));
            if (isNaN(fee) || fee < 0 || fee > 50) {
                return await ctx.reply('❌ Введите корректный процент комиссии от 0 до 50%:');
            }
            await systemConfigService.updateConfig({ fee_percent: fee });
            clearUserState(user.chat_id);
            return await ctx.reply(`✅ Комиссия гаранта обновлена: <b>${fee}%</b>`, {
                parse_mode: 'HTML',
                ...messages.mainMenuReplyKeyboard(true)
            });
        }
    }

    // ==========================================
    // 2. ОБРАБОТКА В ЛИЧНЫХ СООБЩЕНИЯХ (REPLY КНОПКИ И КОМАНДЫ)
    // ==========================================
    if (isPrivate) {
        // Команда /start
        if (text.startsWith('/start')) {
            const parts = text.split(' ');
            const config = await systemConfigService.getConfig();

            // Если запуск по реферальной ссылке сделки: /start deal_ID
            if (parts.length > 1 && parts[1].startsWith('deal_')) {
                const dealId = parts[1].replace('deal_', '');
                const deal = await dealDBService.get({ _id: dealId });
                if (deal) {
                    const cardText = messages.dealCardUser(deal, user.chat_id, isGuarantor);
                    const keyboard = messages.dealInlineKeyboard(deal, user.chat_id);
                    return await ctx.reply(cardText, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                }
            }

            const welcome = messages.startPrivate(user, config);
            return await ctx.reply(welcome.text, {
                parse_mode: 'HTML',
                ...welcome.extra
            });
        }

        // Кнопка: 🤝 Создать сделку
        if (text === '🤝 Создать сделку' || text === '/create') {
            const config = await systemConfigService.getConfig();
            const dealNumber = await getNextDealNumber();
            const escrowWallet = await systemConfigService.getNextEscrowWallet();

            // Пробуем создать отдельную группу для сделки через юзербота
            let createdChatInfo = null;
            if (userbotService.isReady) {
                await ctx.reply('⏳ Создаю отдельную защищенную группу для вашей сделки...');
                createdChatInfo = await userbotService.createDealChat(ctx.botInfo.username, dealNumber);
            }

            const newDeal = await dealDBService.create({
                deal_number: dealNumber,
                chat_id: createdChatInfo ? createdChatInfo.id : null,
                chat_title: createdChatInfo ? createdChatInfo.title : null,
                chat_url: createdChatInfo ? createdChatInfo.url : null,
                status: 'created',
                fee_percent: config.fee_percent,
                assigned_escrow_wallet: escrowWallet,
                buyer: {
                    chat_id: String(user.chat_id),
                    username: user.username || '',
                    first_name: user.first_name || '',
                    return_wallet: user.trc20_wallet || ''
                }
            });

            await auditService.log(newDeal, user.chat_id, 'buyer', 'create_deal', {
                auto_created_chat: !!createdChatInfo
            });
            await adminChannelService.postNewDealCard(newDeal);

            const botInfo = ctx.botInfo;
            const inviteLink = `https://t.me/${botInfo.username}?start=deal_${newDeal._id}`;

            let response = `🎉 <b>Сделка #${dealNumber} успешно создана!</b>\n\n`;
            response += `Вы назначены: <b>Покупатель</b>\n\n`;

            if (createdChatInfo && createdChatInfo.url) {
                response += `👥 <b>Отдельная группа для сделки автоматически создана:</b>\n`;
                response += `👉 <a href="${createdChatInfo.url}"><b>Вступить в группу сделки #${dealNumber}</b></a>\n\n`;
                response += `Отправьте эту ссылку второй стороне: <code>${createdChatInfo.url}</code>\n\n`;

                // Отправляем приветствие прямо в созданную группу
                await sender.sendMessage(createdChatInfo.id, {
                    text: messages.dealGroupWelcome(newDeal).text,
                    extra: messages.dealGroupWelcome(newDeal).extra
                });
            } else {
                response += `🔗 <b>Ссылка-приглашение для второй стороны:</b>\n<code>${inviteLink}</code>\n\n`;
                response += `💡 <i>Вы можете переслать эту ссылку партнеру или добавить бота в существующую группу и написать <code>/link ${dealNumber}</code></i>\n\n`;
            }

            response += `Используйте кнопки ниже для настройки условий сделки:`;

            return await ctx.reply(response, {
                parse_mode: 'HTML',
                disable_web_page_preview: false,
                reply_markup: messages.dealInlineKeyboard(newDeal, user.chat_id)
            });
        }

        // Кнопка: 📋 Мои сделки
        if (text === '📋 Мои сделки' || text === '/my_deals') {
            const userDeals = await dealDBService.getAll({
                $or: [
                    { 'buyer.chat_id': String(user.chat_id) },
                    { 'seller.chat_id': String(user.chat_id) }
                ]
            }, {}, { _id: -1 }, 10);

            if (userDeals.length === 0) {
                return await ctx.reply('У вас пока нет активных или завершенных сделок.', messages.mainMenuReplyKeyboard(isGuarantor));
            }

            let msg = `📋 <b>Ваши последние сделки:</b>\n\n`;
            const inlineKeyboard = [];

            for (const d of userDeals) {
                const role = String(d.buyer.chat_id) === String(user.chat_id) ? 'Покупатель' : 'Продавец';
                msg += `#️⃣ <b>Сделка #${d.deal_number}</b> (${d.amount} USDT)\n`;
                msg += `Роль: ${role} | Статус: ${adminChannelService.getStatusBadge(d.status)}\n\n`;
                inlineKeyboard.push([{ text: `Открыть сделку #${d.deal_number}`, callback_data: `deal_info_${d._id}` }]);
            }

            return await ctx.reply(msg, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        }

        // Кнопка: 💼 Мой кошелек USDT
        if (text === '💼 Мой кошелек USDT' || text === '/wallet') {
            const currentWallet = user.trc20_wallet || '<i>не указан</i>';
            const inlineKeyboard = [
                [{ text: '✏️ Изменить / Указать кошелек', callback_data: 'edit_profile_wallet' }]
            ];

            return await ctx.reply(
                `💼 <b>Ваш кошелек для получения выплат и возвратов (USDT TRC20):</b>\n\n` +
                `${currentWallet}\n\n` +
                `🔒 Этот кошелек используется для автоматической подстановки при участии в сделках.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: inlineKeyboard }
                }
            );
        }

        // Кнопка: ℹ️ Помощь / О сервисе
        if (text === 'ℹ️ Помощь / О сервисе' || text === '/help') {
            const config = await systemConfigService.getConfig();
            return await ctx.reply(
                `ℹ️ <b>О гарант-сервисе:</b>\n\n` +
                `🛡 Сервис предназначен для безопасного проведения сделок в сети TRON (USDT TRC20).\n\n` +
                `🔹 <b>Автоматизация:</b> Бот отслеживает входящие депозиты на защищенные кошельки сервиса через блокчейн в реальном времени.\n` +
                `🔹 <b>Безопасность:</b> Никаких автоматических выводов криптовалюты! Все выплаты продавцам и возвраты покупателям осуществляются гарантом вручную после проверки выполнения условий сделки и TXID.\n` +
                `🔹 <b>Комиссия сервиса:</b> ${config.fee_percent}% (минимум ${config.min_fee_usdt} USDT).\n` +
                `🔹 <b>Работа в группах:</b> Бот создает группу автоматически либо вы можете добавить бота в существующий чат и связать его со сделкой командой <code>/link НОМЕР</code>.\n\n` +
                `По всем вопросам обращайтесь к администрации сервиса.`,
                { parse_mode: 'HTML' }
            );
        }

        // Кнопка: ⚙️ Админ-панель
        if ((text === '⚙️ Админ-панель' || text === '/admin') && isGuarantor) {
            const config = await systemConfigService.getConfig();
            const dealsCount = await dealDBService.getCount();
            const activeDeals = await dealDBService.getCount({ status: { $in: ['created', 'terms_agreed', 'paid', 'completed', 'dispute'] } });
            const disputeDeals = await dealDBService.getCount({ status: 'dispute' });

            let msg = `⚙️ <b>Панель управления Гарант-сервисом</b>\n\n`;
            msg += `📊 Всего сделок в системе: <b>${dealsCount}</b>\n`;
            msg += `⏳ Активных сделок: <b>${activeDeals}</b>\n`;
            msg += `🚨 Сделок в споре: <b>${disputeDeals}</b>\n\n`;
            msg += `⚖️ Текущая комиссия: <b>${config.fee_percent}%</b>\n`;
            msg += `🤖 Статус автосоздания чатов юзерботом: <b>${userbotService.isReady ? '✅ Включено' : '❌ Не авторизован'}</b>\n\n`;
            msg += `🏛 <b>Кошельки сервиса TRC20 (${config.escrow_wallets.length} шт):</b>\n`;
            config.escrow_wallets.forEach((w, i) => {
                const st = w.active ? '🟢' : '🔴';
                msg += `${st} ${i + 1}. <b>${w.label}:</b> <code>${w.address}</code>\n`;
            });

            const inline_keyboard = [
                [{ text: '➕ Добавить кошелек в пул', callback_data: 'adm_add_wallet' }, { text: '🗑 Удалить кошелек', callback_data: 'adm_manage_wallets' }],
                [{ text: '🚨 Сделки в споре (Арбитраж)', callback_data: 'adm_list_disputes' }],
                [{ text: '📋 Все активные сделки', callback_data: 'adm_list_active' }],
                [{ text: '✏️ Изменить % комиссии', callback_data: 'adm_change_fee' }],
                [{ text: '👤 Назначить администратора', callback_data: 'adm_add_admin' }]
            ];

            return await ctx.reply(msg, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard }
            });
        }

        // Кнопка: 📊 Финансовая статистика
        if ((text === '📊 Финансовая статистика' || text === '/stats') && isGuarantor) {
            const completedDeals = await dealDBService.getAll({ status: 'paid_out' });
            const totalTurnover = completedDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
            const totalProfit = completedDeals.reduce((sum, d) => sum + (d.fee_amount || 0), 0);
            const usersCount = await userDBService.getCount();

            const msg = `📊 <b>Финансовая статистика сервиса:</b>\n\n` +
                `👥 Пользователей в базе: <b>${usersCount}</b>\n` +
                `✅ Завершенных успешных сделок: <b>${completedDeals.length}</b>\n` +
                `💰 Общий оборот: <b>${helper.formatMoney(totalTurnover)} USDT</b>\n` +
                `📈 Заработанная комиссия сервиса: <b>${helper.formatMoney(totalProfit)} USDT</b>\n`;

            return await ctx.reply(msg, { parse_mode: 'HTML' });
        }
    }

    // ==========================================
    // 3. ОБРАБОТКА В ГРУППАХ / СУПЕРГРУППАХ
    // ==========================================
    if (isGroup) {
        // Команда создания сделки в группе
        if (text.startsWith('/create') || text.startsWith('/deal')) {
            const config = await systemConfigService.getConfig();
            const dealNumber = await getNextDealNumber();
            const escrowWallet = await systemConfigService.getNextEscrowWallet();

            const newDeal = await dealDBService.create({
                deal_number: dealNumber,
                chat_id: String(chat.id),
                chat_title: chat.title || 'Группа',
                source_chat_id: String(chat.id),
                source_chat_title: chat.title || 'Группа',
                status: 'created',
                fee_percent: config.fee_percent,
                assigned_escrow_wallet: escrowWallet,
                buyer: {
                    chat_id: String(user.chat_id),
                    username: user.username || '',
                    first_name: user.first_name || '',
                    return_wallet: user.trc20_wallet || ''
                }
            });

            await auditService.log(newDeal, user.chat_id, 'buyer', 'create_deal_in_group', { chat_id: chat.id });
            await adminChannelService.postNewDealCard(newDeal);

            const welcome = messages.dealGroupWelcome(newDeal);
            return await ctx.reply(welcome.text, {
                parse_mode: 'HTML',
                ...welcome.extra
            });
        }

        // Команда привязки существующей сделки к чату: /link НОМЕР
        if (text.startsWith('/link')) {
            const parts = text.split(' ');
            if (parts.length < 2) {
                return await ctx.reply('Использование: <code>/link НОМЕР_СДЕЛКИ</code>\nНапример: <code>/link 1001</code>', { parse_mode: 'HTML' });
            }

            const dealNum = parseInt(parts[1], 10);
            const deal = await dealDBService.get({ deal_number: dealNum });
            if (!deal) {
                return await ctx.reply(`❌ Сделка #${dealNum} не найдена.`);
            }

            const updatedDeal = await dealDBService.update({ _id: deal._id }, {
                chat_id: String(chat.id),
                chat_title: chat.title || 'Группа',
                source_chat_id: String(chat.id),
                source_chat_title: chat.title || 'Группа'
            });

            await adminChannelService.updateDealCard(updatedDeal);

            return await ctx.reply(`✅ Чат «${chat.title}» успешно привязан к сделке #${dealNum}!`, {
                reply_markup: messages.dealInlineKeyboard(updatedDeal)
            });
        }

        // Команда просмотра карточки сделки в группе
        if (text === '/info' || text === '/status') {
            const deal = await dealDBService.get({ chat_id: String(chat.id) });
            if (!deal) {
                return await ctx.reply('В этом чате нет активной привязанной сделки. Создайте ее командой /create');
            }
            const card = messages.dealCardUser(deal, user.chat_id, isGuarantor);
            return await ctx.reply(card, {
                parse_mode: 'HTML',
                reply_markup: messages.dealInlineKeyboard(deal, user.chat_id)
            });
        }
    }
};

/**
 * Обработка Callback Query (Инлайн кнопки)
 */
const callbackHandler = async (ctx) => {
    const cb = ctx.callbackQuery;
    if (!cb || !cb.data) return;

    const data = cb.data;
    const user = ctx.state.user;
    const isGuarantor = user.role === 'admin' || user.role === 'guarantor';

    try {
        await ctx.answerCbQuery();
    } catch (e) {}

    // ------------------------------------------
    // Принятие/смена роли в сделке
    // ------------------------------------------
    if (data.startsWith('deal_role_')) {
        const [, , role, dealId] = data.split('_');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        if (deal.status !== 'created') {
            return await ctx.reply('❌ Изменение ролей доступно только на этапе согласования условий.');
        }

        const isCurrentBuyer = deal.buyer && String(deal.buyer.chat_id) === String(user.chat_id);
        const isCurrentSeller = deal.seller && String(deal.seller.chat_id) === String(user.chat_id);

        if (role === 'buyer') {
            // Если уже покупатель
            if (isCurrentBuyer) {
                return await ctx.reply('ℹ️ Вы уже являетесь покупателем в этой сделке.');
            }

            // Если является продавцом, а покупателя еще нет — разрешаем смену роли
            const updateFields = {
                'buyer.chat_id': String(user.chat_id),
                'buyer.username': user.username || '',
                'buyer.first_name': user.first_name || '',
                'buyer.return_wallet': user.trc20_wallet || '',
                'buyer.terms_confirmed': false
            };

            if (isCurrentSeller) {
                updateFields['seller.chat_id'] = null;
                updateFields['seller.username'] = '';
                updateFields['seller.first_name'] = '';
                updateFields['seller.payout_wallet'] = '';
                updateFields['seller.terms_confirmed'] = false;
            } else if (deal.buyer && deal.buyer.chat_id) {
                return await ctx.reply('❌ Место покупателя уже занято другим участником!');
            }

            const updatedDeal = await dealDBService.update({ _id: dealId }, updateFields);
            await adminChannelService.updateDealCard(updatedDeal);
            const card = messages.dealCardUser(updatedDeal, user.chat_id, isGuarantor);
            return await ctx.editMessageText(card, {
                parse_mode: 'HTML',
                reply_markup: messages.dealInlineKeyboard(updatedDeal, user.chat_id)
            });
        }

        if (role === 'seller') {
            // Если уже продавец
            if (isCurrentSeller) {
                return await ctx.reply('ℹ️ Вы уже являетесь продавцом в этой сделке.');
            }

            // Если является покупателем, но место продавца уже занято
            if (!isCurrentBuyer && deal.seller && deal.seller.chat_id) {
                return await ctx.reply('❌ Место продавца уже занято другим участником!');
            }

            // Если у продавца еще не сохранен кошелек, просим его ввести в ЛС
            if (!user.trc20_wallet) {
                setUserState(user.chat_id, 'AWAITING_SELLER_WALLET_DEAL', { deal_id: deal._id });
                await sender.sendMessage(user.chat_id, {
                    text: `👨‍💼 <b>Вы вступаете в сделку #${deal.deal_number} как Продавец!</b>\n\n` +
                        `Пожалуйста, отправьте сюда ваш адрес кошелька <b>USDT TRC20</b>, на который гарант переведет оплату после успешного завершения сделки:\n` +
                        `<i>(Кошелек виден исключительно гаранту для выплаты)</i>`,
                    extra: {
                        reply_markup: {
                            keyboard: [[{ text: '❌ Отмена' }]],
                            resize_keyboard: true
                        }
                    }
                });
                return await ctx.reply(`👨‍💼 @${user.username || user.first_name}, я отправил вам запрос кошелька в личные сообщения бота.`);
            }

            const updateFields = {
                'seller.chat_id': String(user.chat_id),
                'seller.username': user.username || '',
                'seller.first_name': user.first_name || '',
                'seller.payout_wallet': user.trc20_wallet,
                'seller.terms_confirmed': false
            };

            // Если участник меняет роль с покупателя на продавца
            if (isCurrentBuyer) {
                updateFields['buyer.chat_id'] = null;
                updateFields['buyer.username'] = '';
                updateFields['buyer.first_name'] = '';
                updateFields['buyer.return_wallet'] = '';
                updateFields['buyer.terms_confirmed'] = false;
            }

            const updatedDeal = await dealDBService.update({ _id: dealId }, updateFields);
            await adminChannelService.updateDealCard(updatedDeal);
            const card = messages.dealCardUser(updatedDeal, user.chat_id, isGuarantor);
            return await ctx.editMessageText(card, {
                parse_mode: 'HTML',
                reply_markup: messages.dealInlineKeyboard(updatedDeal, user.chat_id)
            });
        }
    }

    // ------------------------------------------
    // Настройка условий и суммы
    // ------------------------------------------
    if (data.startsWith('deal_edit_terms_')) {
        const dealId = data.replace('deal_edit_terms_', '');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        const inline_keyboard = [
            [{ text: '💵 Изменить сумму сделки (USDT)', callback_data: `deal_set_amount_${deal._id}` }],
            [{ text: '📝 Изменить описание условий', callback_data: `deal_set_desc_${deal._id}` }],
            [{ text: '⚖️ Кто оплачивает комиссию?', callback_data: `deal_set_feepayer_${deal._id}` }],
            [{ text: '🔙 Назад к карточке', callback_data: `deal_info_${deal._id}` }]
        ];

        return await ctx.editMessageText(`⚙️ <b>Настройка параметров сделки #${deal.deal_number}</b>\nВыберите действие:`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard }
        });
    }

    // Изменение суммы
    if (data.startsWith('deal_set_amount_')) {
        const dealId = data.replace('deal_set_amount_', '');
        setUserState(user.chat_id, 'AWAITING_DEAL_AMOUNT', { deal_id: dealId });
        await sender.sendMessage(user.chat_id, {
            text: `💵 Введите сумму сделки в <b>USDT</b> (числом, например <code>150</code>):`,
            extra: {
                reply_markup: { keyboard: [[{ text: '❌ Отмена' }]], resize_keyboard: true }
            }
        });
        if (ctx.chat.type !== 'private') {
            await ctx.reply(`@${user.username || user.first_name}, напишите сумму сделки в личных сообщениях боту.`);
        }
        return;
    }

    // Изменение описания
    if (data.startsWith('deal_set_desc_')) {
        const dealId = data.replace('deal_set_desc_', '');
        setUserState(user.chat_id, 'AWAITING_DEAL_TERMS', { deal_id: dealId });
        await sender.sendMessage(user.chat_id, {
            text: `📝 Напишите подробные условия и обязательства сторон для сделки:`,
            extra: {
                reply_markup: { keyboard: [[{ text: '❌ Отмена' }]], resize_keyboard: true }
            }
        });
        if (ctx.chat.type !== 'private') {
            await ctx.reply(`@${user.username || user.first_name}, напишите условия сделки в личных сообщениях боту.`);
        }
        return;
    }

    // Выбор плательщика комиссии
    if (data.startsWith('deal_set_feepayer_')) {
        const dealId = data.replace('deal_set_feepayer_', '');
        const inline_keyboard = [
            [{ text: 'Покупатель', callback_data: `deal_feepayer_buyer_${dealId}` }],
            [{ text: 'Продавец', callback_data: `deal_feepayer_seller_${dealId}` }],
            [{ text: '50 / 50', callback_data: `deal_feepayer_5050_${dealId}` }]
        ];
        return await ctx.editMessageText('⚖️ <b>Кто оплачивает комиссию гаранта?</b>', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard }
        });
    }

    if (data.startsWith('deal_feepayer_')) {
        const [, , payer, dealId] = data.split('_');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        const feePayer = payer === '5050' ? '50/50' : payer;
        const amount = deal.amount || 0;
        const feeAmount = deal.fee_amount || 0;

        let totalDeposit = amount;
        let sellerReceive = amount;

        if (feePayer === 'buyer') {
            totalDeposit = amount + feeAmount;
            sellerReceive = amount;
        } else if (feePayer === 'seller') {
            totalDeposit = amount;
            sellerReceive = Math.max(0, amount - feeAmount);
        } else if (feePayer === '50/50') {
            const half = feeAmount / 2;
            totalDeposit = amount + half;
            sellerReceive = Math.max(0, amount - half);
        }

        const updatedDeal = await dealDBService.update({ _id: dealId }, {
            fee_payer: feePayer,
            total_deposit_amount: Math.round(totalDeposit * 100) / 100,
            seller_receive_amount: Math.round(sellerReceive * 100) / 100,
            'buyer.terms_confirmed': false,
            'seller.terms_confirmed': false
        });

        await adminChannelService.updateDealCard(updatedDeal);
        const card = messages.dealCardUser(updatedDeal, user.chat_id, isGuarantor);
        return await ctx.editMessageText(card, {
            parse_mode: 'HTML',
            reply_markup: messages.dealInlineKeyboard(updatedDeal, user.chat_id)
        });
    }

    // ------------------------------------------
    // Подтверждение условий обеими сторонами
    // ------------------------------------------
    if (data.startsWith('deal_confirm_terms_')) {
        const dealId = data.replace('deal_confirm_terms_', '');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        if (!deal.amount || deal.amount <= 0) {
            return await ctx.reply('❌ Сначала необходимо указать сумму сделки!');
        }

        const isBuyer = deal.buyer && String(deal.buyer.chat_id) === String(user.chat_id);
        const isSeller = deal.seller && String(deal.seller.chat_id) === String(user.chat_id);

        if (!isBuyer && !isSeller) {
            return await ctx.reply('❌ Только участники сделки (покупатель или продавец) могут подтверждать условия.');
        }

        const updateObj = {};
        if (isBuyer) updateObj['buyer.terms_confirmed'] = true;
        if (isSeller) updateObj['seller.terms_confirmed'] = true;

        let updatedDeal = await dealDBService.update({ _id: dealId }, updateObj);

        // Проверяем, подтвердили ли обе стороны
        const buyerOk = isBuyer ? true : (updatedDeal.buyer && updatedDeal.buyer.terms_confirmed);
        const sellerOk = isSeller ? true : (updatedDeal.seller && updatedDeal.seller.terms_confirmed);

        if (buyerOk && sellerOk) {
            // Обе стороны подтвердили! Переводим сделку в статус terms_agreed (ожидание депозита)
            updatedDeal = await dealDBService.update({ _id: dealId }, {
                status: 'terms_agreed'
            });

            await auditService.log(updatedDeal, user.chat_id, isBuyer ? 'buyer' : 'seller', 'terms_agreed');
            await adminChannelService.updateDealCard(updatedDeal);

            // Удаляем старое сообщение с карточкой сделки, чтобы не дублировать информацию
            try {
                await ctx.deleteMessage();
            } catch (err) {
                console.log('Failed to delete old deal message:', err.message);
            }

            const agreedMsg = `🎉 <b>Условия сделки #${updatedDeal.deal_number} согласованы обеими сторонами!</b>\n\n` +
                `📥 <b>Покупателю необходимо внести депозит:</b>\n` +
                `Сумма к оплате: <b>${updatedDeal.total_deposit_amount} USDT TRC20</b>\n` +
                `Адрес кошелька гаранта: <code>${updatedDeal.assigned_escrow_wallet}</code>\n\n` +
                `⚡️ <i>Блокчейн Tron сканируется автоматически каждые 25 секунд. Как только депозит поступит, бот сразу уведомит обе стороны!</i>`;

            return await ctx.reply(agreedMsg, {
                parse_mode: 'HTML',
                reply_markup: messages.dealInlineKeyboard(updatedDeal, user.chat_id)
            });
        } else {
            await adminChannelService.updateDealCard(updatedDeal);
        }

        const card = messages.dealCardUser(updatedDeal, user.chat_id, isGuarantor);
        return await ctx.editMessageText(card, {
            parse_mode: 'HTML',
            reply_markup: messages.dealInlineKeyboard(updatedDeal, user.chat_id)
        });
    }

    // ------------------------------------------
    // Карточка и QR-код оплаты
    // ------------------------------------------
    if (data.startsWith('deal_payment_qr_')) {
        const dealId = data.replace('deal_payment_qr_', '');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        const qrBuffer = await helper.generateQRBuffer(deal.assigned_escrow_wallet);
        const caption = `🏛 <b>Оплата депозита по сделке #${deal.deal_number}</b>\n\n` +
            `💵 <b>Сумма к переводу:</b> <code>${deal.total_deposit_amount}</code> USDT (сеть TRC20)\n` +
            `📥 <b>Адрес кошелька гаранта:</b>\n<code>${deal.assigned_escrow_wallet}</code>\n\n` +
            `⚠️ <i>Отправляйте только USDT TRC20 в указанной сумме. После отправки транзакции дождитесь подтверждения в сети.</i>`;

        if (qrBuffer) {
            return await ctx.replyWithPhoto({ source: qrBuffer }, {
                caption,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔄 Проверить зачисление', callback_data: `deal_check_deposit_${deal._id}` }]]
                }
            });
        } else {
            return await ctx.reply(caption, { parse_mode: 'HTML' });
        }
    }

    // ------------------------------------------
    // Ручная кнопка «Проверить зачисление»
    // ------------------------------------------
    if (data.startsWith('deal_check_deposit_')) {
        const dealId = data.replace('deal_check_deposit_', '');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        if (deal.status !== 'terms_agreed') {
            return await ctx.reply(`Статус сделки: ${adminChannelService.getStatusBadge(deal.status)}`);
        }

        await ctx.reply('🔍 Сканирую блокчейн Tron на наличие входящих переводов...');
        await blockchainService.checkPendingDeposits();

        const refreshed = await dealDBService.get({ _id: dealId });
        if (refreshed.status === 'paid') {
            return await ctx.reply('✅ Депозит найден и подтвержден!');
        } else {
            return await ctx.reply('⏳ Платеж пока не обнаружен. Если вы уже отправили средства, пожалуйста, подождите 1-2 минуты для финализации блоков Tron.');
        }
    }

    // ------------------------------------------
    // Подтверждение выполнения работы (Покупатель подтверждает выплату)
    // ------------------------------------------
    if (data.startsWith('deal_release_')) {
        const dealId = data.replace('deal_release_', '');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        const isBuyer = deal.buyer && String(deal.buyer.chat_id) === String(user.chat_id);
        if (!isBuyer && !isGuarantor) {
            return await ctx.reply('❌ Только покупатель (или гарант) может подтвердить успешное выполнение работы.');
        }

        const updatedDeal = await dealDBService.update({ _id: dealId }, {
            status: 'completed'
        });

        await auditService.log(updatedDeal, user.chat_id, isBuyer ? 'buyer' : user.role, 'buyer_confirmed_release');
        await adminChannelService.updateDealCard(updatedDeal);

        const textMsg = `🎉 <b>Покупатель подтвердил успешное выполнение обязательств!</b>\n\n` +
            `#️⃣ <b>Сделка #${deal.deal_number}</b> переведена в статус ожидания выплаты.\n` +
            `Гарант проверит сделку и вручную переведет <b>${deal.seller_receive_amount} USDT TRC20</b> на кошелек продавца с предоставлением TXID.`;

        await sender.sendMessage(deal.chat_id, {
            text: textMsg,
            extra: { reply_markup: messages.dealInlineKeyboard(updatedDeal) }
        });

        return;
    }

    // ------------------------------------------
    // Открытие спора
    // ------------------------------------------
    if (data.startsWith('deal_dispute_')) {
        const dealId = data.replace('deal_dispute_', '');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        setUserState(user.chat_id, 'AWAITING_DISPUTE_REASON', { deal_id: dealId });
        await sender.sendMessage(user.chat_id, {
            text: `⚠️ <b>Открытие спора по сделке #${deal.deal_number}</b>\n\nПожалуйста, подробно опишите причину спора и суть проблемы:`,
            extra: {
                reply_markup: { keyboard: [[{ text: '❌ Отмена' }]], resize_keyboard: true }
            }
        });

        if (ctx.chat.type !== 'private') {
            await ctx.reply(`@${user.username || user.first_name}, напишите причину спора в личных сообщениях боту.`);
        }
        return;
    }

    // ------------------------------------------
    // Обновление карточки
    // ------------------------------------------
    if (data.startsWith('deal_info_')) {
        const dealId = data.replace('deal_info_', '');
        const deal = await dealDBService.get({ _id: dealId });
        if (!deal) return;

        const card = messages.dealCardUser(deal, user.chat_id, isGuarantor);
        return await ctx.editMessageText(card, {
            parse_mode: 'HTML',
            reply_markup: messages.dealInlineKeyboard(deal, user.chat_id)
        });
    }

    // ------------------------------------------
    // Редактирование кошелька в профиле
    // ------------------------------------------
    if (data === 'edit_profile_wallet') {
        setUserState(user.chat_id, 'AWAITING_WALLET_INPUT');
        return await ctx.reply(
            `Отправьте ваш адрес кошелька <b>USDT TRC20</b> (сеть TRON, начинается с T):`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [[{ text: '❌ Отмена' }]],
                    resize_keyboard: true
                }
            }
        );
    }

    // ==========================================
    // 4. ДЕЙСТВИЯ АДМИНИСТРАТОРА / ГАРАНТА (ИЗ АДМИН-КАНАЛА ИЛИ ПАНЕЛИ)
    // ==========================================
    if (data.startsWith('adm_') && isGuarantor) {
        // Добавление нового кошелька в пул через админку
        if (data === 'adm_add_wallet') {
            setUserState(user.chat_id, 'AWAITING_NEW_ESCROW_WALLET');
            return await ctx.reply(
                `➕ <b>Добавление нового кошелька гаранта в пул</b>\n\n` +
                `Отправьте адрес кошелька <b>USDT TRC20</b> и через пробел необязательное название:\n` +
                `Например:\n<code>T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb Кошелек #4 (Резерв)</code>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { keyboard: [[{ text: '❌ Отмена' }]], resize_keyboard: true }
                }
            );
        }

        // Управление / удаление кошельков из пула
        if (data === 'adm_manage_wallets') {
            const config = await systemConfigService.getConfig();
            const kb = [];

            config.escrow_wallets.forEach((w, idx) => {
                const shortAddr = `${w.address.slice(0, 6)}...${w.address.slice(-6)}`;
                kb.push([
                    { text: `❌ Удалить ${w.label} (${shortAddr})`, callback_data: `adm_del_wallet_${encodeURIComponent(w.address)}` }
                ]);
            });

            kb.push([{ text: '🔙 Назад в админ-панель', callback_data: 'adm_back_to_panel' }]);

            return await ctx.reply('🗑 <b>Выберите кошелек для удаления из пула гарант-сервиса:</b>', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: kb }
            });
        }

        // Удаление конкретного кошелька
        if (data.startsWith('adm_del_wallet_')) {
            const targetAddress = decodeURIComponent(data.replace('adm_del_wallet_', ''));
            const res = await systemConfigService.removeEscrowWallet(targetAddress);
            return await ctx.reply(`🗑 Кошелек <code>${targetAddress}</code> удален из пула.\nОсталось кошельков: <b>${res.count}</b>`, {
                parse_mode: 'HTML'
            });
        }

        // Подтверждение выплаты Продавцу
        if (data.startsWith('adm_payout_seller_')) {
            const dealId = data.replace('adm_payout_seller_', '');
            const deal = await dealDBService.get({ _id: dealId });
            if (!deal) return;

            if (!deal.seller || !deal.seller.payout_wallet) {
                return await ctx.reply(`❌ У продавца не указан кошелек для выплаты в сделке #${deal.deal_number}!`);
            }

            setUserState(user.chat_id, 'AWAITING_PAYOUT_TXID', {
                deal_id: deal._id,
                payout_type: 'seller_payout',
                target_wallet: deal.seller.payout_wallet,
                amount: deal.seller_receive_amount
            });

            await sender.sendMessage(user.chat_id, {
                text: `💸 <b>Ручная выплата Продавцу по сделке #${deal.deal_number}</b>\n\n` +
                    `Сумма к отправке: <b>${deal.seller_receive_amount} USDT TRC20</b>\n` +
                    `Адрес продавца: <code>${deal.seller.payout_wallet}</code>\n\n` +
                    `1. Совершите перевод со своего кошелька на адрес продавца.\n` +
                    `2. Отправьте полученный <b>TXID (хэш транзакции)</b> сюда для автоматической проверки в блокчейне Tron:`,
                extra: {
                    reply_markup: { keyboard: [[{ text: '❌ Отмена' }]], resize_keyboard: true }
                }
            });
            return;
        }

        // Оформление возврата Покупателю
        if (data.startsWith('adm_refund_buyer_')) {
            const dealId = data.replace('adm_refund_buyer_', '');
            const deal = await dealDBService.get({ _id: dealId });
            if (!deal) return;

            const targetWallet = (deal.buyer && deal.buyer.return_wallet) ? deal.buyer.return_wallet : deal.assigned_escrow_wallet;

            setUserState(user.chat_id, 'AWAITING_PAYOUT_TXID', {
                deal_id: deal._id,
                payout_type: 'buyer_refund',
                target_wallet: targetWallet,
                amount: deal.total_deposit_amount
            });

            await sender.sendMessage(user.chat_id, {
                text: `↩️ <b>Ручной возврат Покупателю по сделке #${deal.deal_number}</b>\n\n` +
                    `Сумма к возврату: <b>${deal.total_deposit_amount} USDT TRC20</b>\n` +
                    `Адрес покупателя: <code>${targetWallet}</code>\n\n` +
                    `1. Отправьте USDT на кошелек покупателя.\n` +
                    `2. Введите полученный <b>TXID</b> сюда:`,
                extra: {
                    reply_markup: { keyboard: [[{ text: '❌ Отмена' }]], resize_keyboard: true }
                }
            });
            return;
        }

        // Приостановка сделки
        if (data.startsWith('adm_pause_')) {
            const dealId = data.replace('adm_pause_', '');
            const deal = await dealDBService.get({ _id: dealId });
            if (!deal) return;

            const updatedDeal = await dealDBService.update({ _id: dealId }, {
                status: 'paused',
                previous_status: deal.status
            });

            await auditService.log(updatedDeal, user.chat_id, user.role, 'pause_deal');
            await adminChannelService.updateDealCard(updatedDeal);

            if (deal.chat_id) {
                await sender.sendMessage(deal.chat_id, {
                    text: `⏸ <b>Сделка #${deal.deal_number} приостановлена администратором!</b> Все действия временно заморожены.`
                });
            }
            return;
        }

        // Возобновление сделки
        if (data.startsWith('adm_resume_')) {
            const dealId = data.replace('adm_resume_', '');
            const deal = await dealDBService.get({ _id: dealId });
            if (!deal) return;

            const restoredStatus = deal.previous_status || 'paid';
            const updatedDeal = await dealDBService.update({ _id: dealId }, {
                status: restoredStatus
            });

            await auditService.log(updatedDeal, user.chat_id, user.role, 'resume_deal');
            await adminChannelService.updateDealCard(updatedDeal);

            if (deal.chat_id) {
                await sender.sendMessage(deal.chat_id, {
                    text: `▶️ <b>Сделка #${deal.deal_number} возобновлена!</b>`
                });
            }
            return;
        }

        // Отмена сделки
        if (data.startsWith('adm_cancel_')) {
            const dealId = data.replace('adm_cancel_', '');
            const deal = await dealDBService.get({ _id: dealId });
            if (!deal) return;

            const updatedDeal = await dealDBService.update({ _id: dealId }, {
                status: 'canceled'
            });

            await auditService.log(updatedDeal, user.chat_id, user.role, 'cancel_deal');
            await adminChannelService.updateDealCard(updatedDeal);

            if (deal.chat_id) {
                await sender.sendMessage(deal.chat_id, {
                    text: `❌ <b>Сделка #${deal.deal_number} отменена администратором.</b>`
                });
            }
            return;
        }

        // Обновить карточку в канале
        if (data.startsWith('adm_refresh_')) {
            const dealId = data.replace('adm_refresh_', '');
            const deal = await dealDBService.get({ _id: dealId });
            if (deal) {
                await adminChannelService.updateDealCard(deal);
            }
            return;
        }

        // Сделки в споре (список)
        if (data === 'adm_list_disputes') {
            const disputeDeals = await dealDBService.getAll({ status: 'dispute' });
            if (disputeDeals.length === 0) {
                return await ctx.reply('✅ Активных споров нет.');
            }

            let msg = `🚨 <b>Сделки на рассмотрении в арбитраже:</b>\n\n`;
            const kb = [];
            for (const d of disputeDeals) {
                msg += `#️⃣ Сделка #${d.deal_number} (${d.amount} USDT)\nПричина: <i>${d.dispute.reason || '—'}</i>\n\n`;
                kb.push([{ text: `Открыть сделку #${d.deal_number}`, callback_data: `deal_info_${d._id}` }]);
            }
            return await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
        }

        // Изменить комиссию
        if (data === 'adm_change_fee' && user.role === 'admin') {
            setUserState(user.chat_id, 'AWAITING_CONFIG_FEE');
            return await ctx.reply('Введите новый процент комиссии сервиса (например, <code>5</code> или <code>3.5</code>):', {
                parse_mode: 'HTML',
                reply_markup: { keyboard: [[{ text: '❌ Отмена' }]], resize_keyboard: true }
            });
        }

        // Добавить админа
        if (data === 'adm_add_admin' && user.role === 'admin') {
            setUserState(user.chat_id, 'AWAITING_NEW_ADMIN_ID');
            return await ctx.reply('Введите Telegram ID пользователя или @username для назначения администратором:', {
                reply_markup: { keyboard: [[{ text: '❌ Отмена' }]], resize_keyboard: true }
            });
        }
    }
};

module.exports = {
    userMiddleware,
    textHandler,
    callbackHandler
};
