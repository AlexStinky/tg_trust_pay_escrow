const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ConnectedChatSchema = new Schema({
    chat_id: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    title: {
        type: String,
        default: ''
    },
    type: {
        type: String // 'group' или 'supergroup'
    },
    username: {
        type: String
    },
    is_active: {
        type: Boolean,
        default: true
    },
    added_at: {
        type: Date,
        default: Date.now
    }
}, { versionKey: false });

const ConnectedChat = mongoose.model('ConnectedChat', ConnectedChatSchema);

module.exports = {
    ConnectedChat
};

