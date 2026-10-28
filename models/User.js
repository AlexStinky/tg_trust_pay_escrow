const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
    chat_id: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    username: {
        type: String,
    },
    first_name: {
        type: String,
    },
    role: {
        type: String,
        default: 'user' // 'user', 'guarantor', 'admin'
    },
    trc20_wallet: {
        type: String,
        default: ''
    },
    deals_count: {
        type: Number,
        default: 0
    },
    deals_successful: {
        type: Number,
        default: 0
    },
    is_blocked: {
        type: Boolean,
        default: false
    },
    created_at: {
        type: Date,
        default: Date.now
    }
}, { versionKey: false });

const User = mongoose.model('User', UserSchema);

module.exports = {
    User
};
