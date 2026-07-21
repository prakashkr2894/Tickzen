import mongoose from 'mongoose';

const panelSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Panel name is required'],
    trim: true
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  order: {
    type: Number,
    default: 0
  },
  color: {
    type: String,
    default: '#007bff'
  },
  width: {
    type: Number,
    default: 224,
    min: 180
  },
  height: {
    type: Number,
    default: 364,
    min: 260
  }
}, {
  timestamps: true
});

// Index: panel lookups are always filtered by projectId and sorted by order
panelSchema.index({ projectId: 1, order: 1 });

const Panel = mongoose.model('Panel', panelSchema);

export default Panel;
