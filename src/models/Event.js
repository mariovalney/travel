const mongoose = require('mongoose');

const tagSchema = new mongoose.Schema({
  label: { type: String, required: true },
  style: { type: String, enum: ['default', 'dark', 'red'], default: 'default' },
}, { _id: false });

const eventFileSchema = new mongoose.Schema({
  diskName: { type: String, required: true, trim: true },
  displayName: { type: String, required: true, trim: true },
}, { _id: false });

const eventSchema = new mongoose.Schema({
  day:             { type: Number, required: true, min: 0, max: 3 },
  order:           { type: Number, required: true },
  /** Legado; a app usa só isoTime. Mantido para documentos antigos no Mongo. */
  time:            { type: String, default: '' },
  isoTime:         {
    type: String,
    required: [true, 'isoTime obrigatório'],
    validate: {
      validator(v) {
        return typeof v === 'string' && !Number.isNaN(Date.parse(v.trim()));
      },
      message: 'isoTime deve ser uma data ISO válida',
    },
  },
  title:           {
    type: String,
    required: [true, 'Título obrigatório'],
    trim: true,
    minlength: 1,
  },
  description:     { type: String, default: '' },
  link:            { type: String, default: '' },
  location: {
    address: { type: String, default: '' },
    lat:     { type: Number, default: null },
    lng:     { type: Number, default: null },
  },
  durationMinutes: { type: Number, default: null },
  tags:            { type: [tagSchema], default: [] },
  photos:          { type: [String], default: [] },
  files:           { type: [eventFileSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('Event', eventSchema);
