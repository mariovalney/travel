const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email:          { type: String, required: true, unique: true, lowercase: true },
  name:           { type: String, default: '' },
  photo:          { type: String, default: null },
  lastLogin:      { type: Date, default: Date.now },
  shareLocation:  { type: Boolean, default: true },
  lastLat:        { type: Number, default: null },
  lastLng:        { type: Number, default: null },
  lastLocationAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
