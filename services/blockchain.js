const axios = require('axios');
const { TronWeb } = require('tronweb');
const { dealDBService, paymentDBService, auditService, systemConfigService } = require('./db');

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID_API_URL = 'https://api.trongrid.io';
const TRONSCAN_API_URL = 'https://apilist.tronscanapi.com';

class BlockchainService {
    constructor() {
        this.apiKey = process.env.TRON_API_KEY || '';
        this.tronWeb = new TronWeb({
            fullHost: TRONGRID_API_URL,
            headers: this.apiKey ? { 'TRON-PRO-API-KEY': this.apiKey } : {}
        });

        this.isChecking = false;
        this.sender = null;
        this.adminChannel = null;
    }

    setDependencies(sender, adminChannel) {
        this.sender = sender;
        this.adminChannel = adminChannel;
    }

    /**
     * Валидация Tron TRC20 адреса
     */
    isValidTronAddress(address) {
        if (!address || typeof address !== 'string') return false;
        return TronWeb.isAddress(address);
    }

    /**
     * Запуск периодического мониторинга депозитов
     */
    startMonitoring(intervalMs = 30000) {
        console.log(`[Blockchain] Запущен мониторинг USDT TRC20 депозитов (интервал ${intervalMs / 1000} сек)`);
        this.checkPendingDeposits();
        setInterval(() => this.checkPendingDeposits(), intervalMs);
    }

    /**
     * Сканирование входящих переводов для сделок в статусе terms_agreed
     */
    async checkPendingDeposits() {
        if (this.isChecking) return;
        this.isChecking = true;

        try {
            // Находим все сделки, ожидающие депозит
            const pendingDeals = await dealDBService.getAll({
                status: 'terms_agreed',
                assigned_escrow_wallet: { $exists: true, $ne: '' }
            });

            if (pendingDeals.length === 0) {
                this.isChecking = false;
                return;
            }

            // Получаем уникальные кошельки гаранта, на которые ожидаются платежи
            const walletsToCheck = [...new Set(pendingDeals.map(d => d.assigned_escrow_wallet))];

            for (const wallet of walletsToCheck) {
                await this.scanWalletTransfers(wallet, pendingDeals.filter(d => d.assigned_escrow_wallet === wallet));
            }
        } catch (error) {
            console.error('[Blockchain Check Error]:', error.message);
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * Сканирование переводов по конкретному кошельку через TronGrid API (или фоллбэк на TronScan)
     */
    async scanWalletTransfers(walletAddress, dealsForWallet) {
        if (!this.isValidTronAddress(walletAddress)) return;

        try {
            const transfers = await this.fetchIncomingTrc20Transfers(walletAddress);
            if (!transfers || transfers.length === 0) return;

            for (const tx of transfers) {
                const txid = tx.transaction_id || tx.txid || tx.hash;
                const valueRaw = tx.value || tx.amount;
                // TRC20 USDT имеет 6 знаков
                const amount = Number(valueRaw) / 1000000;
                const fromAddress = tx.from || tx.transferFromAddress;

                if (!txid || !amount || amount <= 0) continue;

                // Проверяем, не обрабатывалась ли уже эта транзакция
                const existingPayment = await paymentDBService.get({ txid });
                if (existingPayment) continue;

                // Ищем сделку, которой соответствует эта сумма (с допуском 0.05 USDT на округления или точное совпадение)
                // Сначала ищем точное совпадение по total_deposit_amount
                const matchedDeal = dealsForWallet.find(deal => {
                    const expected = Number(deal.total_deposit_amount);
                    return Math.abs(expected - amount) < 0.05 && deal.status === 'terms_agreed';
                });

                if (matchedDeal) {
                    await this.processSuccessfulDeposit(matchedDeal, txid, amount, fromAddress);
                }
            }
        } catch (error) {
            console.error(`[Blockchain Scan ${walletAddress} Error]:`, error.message);
        }
    }

    /**
     * Получить входящие TRC20 переводы для кошелька
     */
    async fetchIncomingTrc20Transfers(walletAddress) {
        try {
            const headers = { 'accept': 'application/json' };
            if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;

            const url = `${TRONGRID_API_URL}/v1/accounts/${walletAddress}/transactions/trc20`;
            const res = await axios.get(url, {
                headers,
                params: {
                    contract_address: USDT_TRC20_CONTRACT,
                    only_to: true,
                    only_confirmed: true,
                    limit: 30
                },
                timeout: 10000
            });

            if (res.data && res.data.data) {
                return res.data.data;
            }
        } catch (e) {
            // Фоллбэк на TronScan
            try {
                const tronScanUrl = `${TRONSCAN_API_URL}/api/token_trc20/transfers-with-status`;
                const res2 = await axios.get(tronScanUrl, {
                    params: {
                        limit: 30,
                        start: 0,
                        direction: 2, // Входящие
                        trc20Id: USDT_TRC20_CONTRACT,
                        address: walletAddress
                    },
                    timeout: 10000
                });
                if (res2.data && res2.data.data) {
                    return res2.data.data;
                }
            } catch (e2) {
                console.error('[Blockchain API Fallback Error]:', e2.message);
            }
        }
        return [];
    }

    /**
     * Обработка подтвержденного входящего депозита
     */
    async processSuccessfulDeposit(deal, txid, amountReceived, fromAddress) {
        console.log(`[Blockchain] ✅ Найден депозит для сделки #${deal.deal_number}: ${amountReceived} USDT (TXID: ${txid})`);

        // Записываем в базу Payment для защиты от повторной обработки
        await paymentDBService.create({
            acquiring: 'trc20_blockchain',
            address: deal.assigned_escrow_wallet,
            from: fromAddress,
            order_id: deal._id.toString(),
            amount: String(amountReceived),
            payment_amount: String(amountReceived),
            payment_amount_usd: String(amountReceived),
            currency: 'USDT',
            network: 'TRC20',
            status: 'paid',
            txid
        });

        // Обновляем сделку
        const updatedDeal = await dealDBService.update({ _id: deal._id }, {
            status: 'paid',
            deposit_txid: txid,
            deposit_amount_received: amountReceived,
            deposit_confirmed_at: new Date()
        });

        await auditService.log(updatedDeal, 'system', 'system', 'deposit_detected', {
            amount: amountReceived,
            txid,
            from: fromAddress,
            escrow_wallet: deal.assigned_escrow_wallet
        });

        // Уведомление в чат сделки
        if (this.sender && updatedDeal.chat_id) {
            const depositMsg = `💰 <b>Депозит успешно получен и подтвержден блокчейном!</b>\n\n` +
                `#️⃣ <b>Сделка #${updatedDeal.deal_number}</b>\n` +
                `💵 <b>Поступило:</b> ${amountReceived} USDT TRC20\n` +
                `🔗 <b>TXID:</b> <code>${txid}</code>\n\n` +
                `🔒 Средства заморожены на кошельке гаранта.\n` +
                `👤 <b>Продавец</b>, можете приступать к выполнению условий сделки!\n` +
                `После завершения и проверки покупатель сможет подтвердить получение и запросить выплату.`;

            const inlineKeyboard = [
                [{ text: '📋 Детали сделки', callback_data: `deal_info_${updatedDeal._id}` }],
                [{ text: '✅ Подтвердить получение (Выплата продавцу)', callback_data: `deal_release_${updatedDeal._id}` }],
                [{ text: '⚠️ Открыть спор', callback_data: `deal_dispute_${updatedDeal._id}` }]
            ];

            await this.sender.sendMessage(updatedDeal.chat_id, {
                text: depositMsg,
                extra: { reply_markup: { inline_keyboard } }
            });
        }

        // Обновление карточки в закрытом канале администраторов
        if (this.adminChannel) {
            await this.adminChannel.updateDealCard(updatedDeal);
        }
    }

    /**
     * Проверка TXID исходящего перевода гарантом (проверка выплат продавцу и возвратов покупателю)
     */
    async verifyTxid(txid, expectedToWallet = null, expectedMinAmount = 0) {
        try {
            if (!txid || typeof txid !== 'string') {
                return { success: false, message: 'Некорректный TXID' };
            }

            const cleanTxid = txid.trim();

            // Проверяем, не использовался ли уже этот TXID для других выплат
            const alreadyUsed = await dealDBService.get({
                'payout.txid': cleanTxid
            });
            if (alreadyUsed) {
                return { success: false, message: `Этот TXID уже был использован в сделке #${alreadyUsed.deal_number}` };
            }

            // Получаем транзакцию через TronWeb
            const txInfo = await this.tronWeb.trx.getTransactionInfo(cleanTxid);

            if (!txInfo || !txInfo.id) {
                return { success: false, message: 'Транзакция пока не найдена в блокчейне Tron (попробуйте через 10-20 секунд)' };
            }

            // Проверяем статус исполнения в блокчейне
            const isSuccess = txInfo.receipt && txInfo.receipt.result === 'SUCCESS';
            if (!isSuccess) {
                const failReason = txInfo.receipt ? txInfo.receipt.result : 'FAILED';
                return { success: false, message: `Транзакция в блокчейне завершилась со статусом: ${failReason}` };
            }

            // Проверяем смарт-контракт USDT и трансфер, если есть логи
            let recipientFound = false;
            let transferAmount = 0;

            if (txInfo.log && Array.isArray(txInfo.log)) {
                for (const log of txInfo.log) {
                    // Проверяем топик Transfer: ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
                    if (log.topics && log.topics[0] && log.topics[0].includes('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')) {
                        if (log.data) {
                            transferAmount = parseInt(log.data, 16) / 1000000;
                        }
                        if (log.topics[2]) {
                            const toHex = '41' + log.topics[2].slice(-40);
                            const toBase58 = TronWeb.address.fromHex(toHex);
                            if (expectedToWallet && toBase58.toLowerCase() === expectedToWallet.toLowerCase()) {
                                recipientFound = true;
                            }
                        }
                    }
                }
            }

            return {
                success: true,
                txid: cleanTxid,
                blockNumber: txInfo.blockNumber,
                amount: transferAmount,
                recipientMatched: expectedToWallet ? recipientFound : true
            };
        } catch (error) {
            console.error('[Verify TXID Error]:', error.message);
            return { success: false, message: `Ошибка при проверке TXID: ${error.message}` };
        }
    }
}

const blockchainService = new BlockchainService();

module.exports = {
    blockchainService,
    USDT_TRC20_CONTRACT
};

