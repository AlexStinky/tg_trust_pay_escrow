const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ActionLogSchema = new Schema({
    deal_id: {
        type: Schema.Types.ObjectId,
        ref: 'Deal',
        index: true
    },
    deal_number: {
        type: Number,
        index: true
    },
    actor_id: {
        type: String, // Telegram chat_id пользователя или 'system'
        required: true
    },
    actor_role: {
        type: String // 'buyer', 'seller', 'guarantor', 'admin', 'system'
    },
    action: {
        type: String, // 'create_deal', 'agree_terms', 'deposit_detected', 'manual_payout', etc.
        required: true
    },
    details: {
        type: Schema.Types.Mixed
    },
    created_at: {
        type: Date,
        default: Date.now,
        index: true
    }
}, { versionKey: false });

const ActionLog = mongoose.model('ActionLog', ActionLogSchema);

module.exports = {
    ActionLog
};

