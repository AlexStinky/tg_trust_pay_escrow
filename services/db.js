const { User } = require('../models/User');
const { Deal } = require('../models/Deal');
const { Payment } = require('../models/Payment');
const { ActionLog } = require('../models/ActionLog');
const { SystemConfig } = require('../models/SystemConfig');
const { ConnectedChat } = require('../models/ConnectedChat');
const { getNextDealNumber } = require('../models/Counter');

class DBMethods {
    constructor(model) {
        this.Model = model;
    }

    async create(data) {
        try {
            return await this.Model.create(data);
        } catch (error) {
            console.error(`[DB Create Error ${this.Model.modelName}]:`, error.message);
            return null;
        }
    }

    async get(req) {
        try {
            return await this.Model.findOne(req);
        } catch (error) {
            console.error(`[DB Get Error ${this.Model.modelName}]:`, error.message);
            return null;
        }
    }

    async getAll(req = {}, projection = {}, sort = { _id: -1 }, limit = 0) {
        try {
            const query = this.Model.find(req, projection).sort(sort);
            if (limit > 0) query.limit(limit);
            return await query.exec();
        } catch (error) {
            console.error(`[DB GetAll Error ${this.Model.modelName}]:`, error.message);
            return [];
        }
    }

    async update(req, update, returnDocument = 'after', upsert = false) {
        try {
            return await this.Model.findOneAndUpdate(req, update, {
                upsert,
                new: returnDocument === 'after'
            });
        } catch (error) {
            console.error(`[DB Update Error ${this.Model.modelName}]:`, error.message);
            return null;
        }
    }

    async updateAll(req, update) {
        try {
            return await this.Model.updateMany(req, update);
        } catch (error) {
            console.error(`[DB UpdateAll Error ${this.Model.modelName}]:`, error.message);
            return null;
        }
    }

    async delete(req) {
        try {
            return await this.Model.findOneAndDelete(req);
        } catch (error) {
            console.error(`[DB Delete Error ${this.Model.modelName}]:`, error.message);
            return null;
        }
    }

    async getCount(req = {}) {
        try {
            return await this.Model.countDocuments(req);
        } catch (error) {
            console.error(`[DB Count Error ${this.Model.modelName}]:`, error.message);
            return 0;
        }
    }
}

// Сервис системного конфига и управления кошельками
const systemConfigService = {
    async getConfig() {
        let config = await SystemConfig.findById('main_config');
        if (!config) {
            const defaultWallets = [];
            if (process.env.ESCROW_WALLET_1) defaultWallets.push({ address: process.env.ESCROW_WALLET_1, label: 'Кошелек #1', active: true });
            if (process.env.ESCROW_WALLET_2) defaultWallets.push({ address: process.env.ESCROW_WALLET_2, label: 'Кошелек #2', active: true });
            if (process.env.ESCROW_WALLET_3) defaultWallets.push({ address: process.env.ESCROW_WALLET_3, label: 'Кошелек #3', active: true });

            if (defaultWallets.length === 0) {
                defaultWallets.push(
                    { address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', label: 'Кошелек #1', active: true }
                );
            }

            config = await SystemConfig.create({
                _id: 'main_config',
                escrow_wallets: defaultWallets,
                fee_percent: 5,
                min_fee_usdt: 2,
                min_deal_amount: 5,
                admin_channel_id: process.env.ADMIN_CHANNEL_ID || ''
            });
        }
        return config;
    },

    async updateConfig(update) {
        return await SystemConfig.findByIdAndUpdate('main_config', update, { new: true, upsert: true });
    },

    // Добавить новый кошелек в пул
    async addEscrowWallet(address, label = null) {
        const config = await this.getConfig();
        const exists = config.escrow_wallets.some(w => w.address.toLowerCase() === address.toLowerCase());
        if (exists) {
            return { success: false, message: 'Этот кошелек уже добавлен в систему' };
        }

        const newLabel = label || `Кошелек #${config.escrow_wallets.length + 1}`;
        config.escrow_wallets.push({
            address,
            label: newLabel,
            active: true
        });

        await config.save();
        return { success: true, count: config.escrow_wallets.length };
    },

    // Удалить кошелек из пула
    async removeEscrowWallet(address) {
        const config = await this.getConfig();
        config.escrow_wallets = config.escrow_wallets.filter(w => w.address.toLowerCase() !== address.toLowerCase());
        await config.save();
        return { success: true, count: config.escrow_wallets.length };
    },

    // Включить/выключить кошелек
    async toggleEscrowWallet(address) {
        const config = await this.getConfig();
        const wallet = config.escrow_wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
        if (wallet) {
            wallet.active = !wallet.active;
            await config.save();
            return { success: true, active: wallet.active };
        }
        return { success: false };
    },

    // Выбрать наименее загруженный активный кошелек из пула
    async getNextEscrowWallet() {
        const config = await this.getConfig();
        const activeWallets = (config.escrow_wallets || []).filter(w => w.active && w.address && !w.address.includes('xxxx'));
        if (activeWallets.length === 0) {
            return config.escrow_wallets && config.escrow_wallets[0] ? config.escrow_wallets[0].address : 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
        }

        // Считаем активные сделки (в статусе terms_agreed - ожидающие депозит) на каждом кошельке
        const counts = await Promise.all(activeWallets.map(async w => {
            const count = await Deal.countDocuments({
                assigned_escrow_wallet: w.address,
                status: 'terms_agreed'
            });
            return { address: w.address, count };
        }));

        counts.sort((a, b) => a.count - b.count);
        return counts[0].address;
    }
};

// Сервис логирования действий безопасности
const auditService = {
    async log(deal, actorId, actorRole, action, details = {}) {
        try {
            await ActionLog.create({
                deal_id: deal ? deal._id : null,
                deal_number: deal ? deal.deal_number : null,
                actor_id: String(actorId),
                actor_role: actorRole,
                action,
                details
            });
        } catch (e) {
            console.error('[Audit Log Error]:', e.message);
        }
    }
};

const userDBService = new DBMethods(User);
const dealDBService = new DBMethods(Deal);
const paymentDBService = new DBMethods(Payment);
const actionLogDBService = new DBMethods(ActionLog);
const connectedChatDBService = new DBMethods(ConnectedChat);

module.exports = {
    userDBService,
    dealDBService,
    paymentDBService,
    actionLogDBService,
    connectedChatDBService,
    systemConfigService,
    auditService,
    getNextDealNumber
};
