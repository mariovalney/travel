const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true },
  subscription: { type: Object, required: true },
}, { timestamps: true });

module.exports = mongoose.model('PushSubscription', schema);
